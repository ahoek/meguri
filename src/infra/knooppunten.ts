import type { LngLat } from '../domain/geo'
import type { NetworkLeg, NetworkNode } from '../domain/knooppunten'

/**
 * Where the numbered junctions are, from OpenStreetMap via Overpass.
 *
 * The numbers exist nowhere else — BRouter knows a way belongs to a cycle
 * network but not that this crossroads is 45 — so there is no avoiding a
 * second service. Overpass is the heaviest and least reliable of the free
 * ones this app leans on, so: only when the feature is switched on, keyed to
 * a coarse grid square rather than the exact loop, and kept for weeks.
 * Planning repeatedly around home should cost one query, ever.
 */

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
]

const CACHE_PREFIX = 'meguri-knooppunten-'
// Junctions get renumbered about as often as roads get rebuilt.
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000
// Grid squares of a twentieth of a degree — roughly 5.5 km north to south.
// Requests snap outward to this, so nudging the start down the road reuses
// the same answer instead of asking again.
const GRID = 0.05

export interface NetworkData {
  nodes: NetworkNode[]
  legs: NetworkLeg[]
}

interface Cached extends NetworkData {
  at: number
}

const memory = new Map<string, NetworkData>()

/** The grid-aligned box covering a circle, as [south, west, north, east]. */
function gridBox(centre: LngLat, radiusKm: number) {
  const dLat = radiusKm / 111
  const dLng = radiusKm / (111 * Math.cos((centre[1] * Math.PI) / 180) || 1)
  const floor = (n: number) => Math.floor(n / GRID) * GRID
  const ceil = (n: number) => Math.ceil(n / GRID) * GRID
  return [
    floor(centre[1] - dLat),
    floor(centre[0] - dLng),
    ceil(centre[1] + dLat),
    ceil(centre[0] + dLng),
  ].map((n) => Number(n.toFixed(2)))
}

function readCache(key: string): NetworkData | null {
  const held = memory.get(key)
  if (held) return held
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Cached
    if (!parsed?.nodes || !parsed?.legs || Date.now() - parsed.at > CACHE_TTL_MS) return null
    const data = { nodes: parsed.nodes, legs: parsed.legs }
    memory.set(key, data)
    return data
  } catch {
    return null
  }
}

function writeCache(key: string, data: NetworkData) {
  memory.set(key, data)
  try {
    localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ at: Date.now(), ...data }))
  } catch {
    /* quota — the in-memory copy still serves this session */
  }
}

/** Ask each mirror in turn; the main one answers 504 often enough to matter. */
async function ask(body: string, signal?: AbortSignal) {
  let last: unknown = null
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, { method: 'POST', body, signal })
      if (res.ok) return await res.json()
      last = new Error(`Overpass failed (${res.status})`)
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
      last = err
    }
  }
  throw last ?? new Error('Overpass unreachable')
}

/**
 * The cycling network around `centre`: the junctions and, just as
 * importantly, the signposted legs joining them.
 *
 * The legs come back as tags only — `ref="32-33"` — which is all the graph
 * needs and a fraction of the payload their geometry would be. Returns
 * nothing where the network doesn't exist, which is most of the world.
 */
export async function fetchCycleNetwork(
  centre: LngLat,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<NetworkData> {
  const box = gridBox(centre, radiusKm)
  const key = box.join(',')
  const cached = readCache(key)
  if (cached) return cached

  const query =
    `[out:json][timeout:60];` +
    `node["network:type"="node_network"]["rcn_ref"](${key});out qt;` +
    `relation["network:type"="node_network"]["network"="rcn"]["route"="bicycle"](${key});` +
    `out tags;`

  const json = await ask(query, signal)
  const elements: {
    type: string
    lat?: number
    lon?: number
    tags?: Record<string, string>
  }[] = json.elements ?? []

  const nodes: NetworkNode[] = elements
    .filter((n) => n.type === 'node' && n.lat != null && n.lon != null && n.tags?.rcn_ref)
    .map((n) => ({ ref: n.tags!.rcn_ref, lngLat: [n.lon!, n.lat!] as LngLat }))

  const legs: NetworkLeg[] = []
  for (const el of elements) {
    if (el.type !== 'relation') continue
    const match = /^(\S+)-(\S+)$/.exec(el.tags?.ref ?? '')
    if (match) legs.push({ a: match[1], b: match[2] })
  }

  const data = { nodes, legs }
  writeCache(key, data)
  return data
}
