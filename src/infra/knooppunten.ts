import type { LngLat } from '../domain/geo'
import type { LegWay, NetworkLeg, NetworkNode } from '../domain/knooppunten'

/**
 * Where the numbered junctions are, and what the legs between them look like.
 *
 * Two sources, chosen for how often they are asked.
 *
 * The network — junctions, and each leg as its two numbers and its ridden
 * length — is a few hundred kilobytes for the whole of the Low Countries and
 * changes about as often as roads are rebuilt. It ships with the app as
 * half-degree tiles built by `scripts/fetch-knooppunten.mjs`; planning
 * reads the two to four under the ride. It used to be asked of Overpass at
 * plan time, which allows two concurrent queries per address: two browsers
 * open in one flat, and the planner was answered 429 and hung.
 *
 * The chosen legs' geometry is asked for per plan — about nine relations —
 * from the OSM API, which has no such limit for a handful of reads and
 * answered in a quarter of a second, with Overpass as the fallback. Each
 * leg is kept once seen, so re-rolling around home asks only for the new
 * ones.
 */

// Half a degree. Must agree with TILE in scripts/fetch-knooppunten.mjs.
const TILE = 0.5

const OSM_API = 'https://api.openstreetmap.org/api/0.6'
// Probed 2026-09-11: kumi.systems and private.coffee hung for 20 s and
// answered nothing; these answered in under half a second, with CORS.
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]
// A mirror that has not answered by now is not going to be the quick one.
const ASK_TIMEOUT_MS = 15_000
// How many legs to ask the OSM API for at once.
const PARALLEL = 6

const LEG_PREFIX = 'meguri-knooppunt-leg-'
// Legs get remapped about as often as roads get rebuilt.
const LEG_TTL_MS = 30 * 24 * 60 * 60 * 1000

export interface NetworkData {
  nodes: NetworkNode[]
  legs: NetworkLeg[]
}

interface Tile {
  at: string
  nodes: [ref: string, lng: number, lat: number][]
  legs: [a: string, b: string, id: number, km: number, w: number, s: number, e: number, n: number][]
}

const tiles = new Map<string, Promise<Tile | null>>()
const legMemory = new Map<number, LegWay[]>()

const tileKey = (lat: number, lng: number) => `${lat.toFixed(1)}_${lng.toFixed(1)}`

/** The tile keys covering a circle. */
function tilesCovering(centre: LngLat, radiusKm: number): string[] {
  const dLat = radiusKm / 111
  const dLng = radiusKm / (111 * Math.cos((centre[1] * Math.PI) / 180) || 1)
  const floor = (n: number) => Math.floor(n / TILE) * TILE
  const keys: string[] = []
  for (let lat = floor(centre[1] - dLat); lat <= centre[1] + dLat; lat = +(lat + TILE).toFixed(1)) {
    for (let lng = floor(centre[0] - dLng); lng <= centre[0] + dLng; lng = +(lng + TILE).toFixed(1)) {
      keys.push(tileKey(lat, lng))
    }
  }
  return keys
}

/** One tile from beside the app; null where the network has nothing there. */
function loadTile(key: string, signal?: AbortSignal): Promise<Tile | null> {
  let held = tiles.get(key)
  if (!held) {
    held = (async () => {
      const res = await fetch(`${import.meta.env.BASE_URL}knooppunten/${key}.json`, { signal })
      // A tile that isn't there is the sea, or a region without the network.
      // Checked by type as well as status: the dev server answers a missing
      // file with the app's own HTML page and a 200.
      if (res.status === 404 || !res.headers.get('content-type')?.includes('json')) return null
      if (!res.ok) throw new Error(`Tile ${key} failed (${res.status})`)
      return (await res.json()) as Tile
    })()
    tiles.set(key, held)
    // A failure is not an answer to keep: the next plan asks again.
    held.catch(() => tiles.delete(key))
  }
  return held
}

/**
 * The cycling network around `centre`: the junctions and, just as
 * importantly, the signposted legs joining them, with their lengths.
 * Returns nothing where the network doesn't exist, which is most of the
 * world; throws where the tiles could not be read at all.
 */
export async function fetchCycleNetwork(
  centre: LngLat,
  radiusKm: number,
  signal?: AbortSignal,
): Promise<NetworkData> {
  const loaded = await Promise.all(tilesCovering(centre, radiusKm).map((k) => loadTile(k, signal)))
  const nodes: NetworkNode[] = []
  const legs = new Map<number, NetworkLeg>()
  for (const tile of loaded) {
    if (!tile) continue
    for (const [ref, lng, lat] of tile.nodes) nodes.push({ ref, lngLat: [lng, lat] })
    // A leg spanning two tiles is in both.
    for (const [a, b, id, km, w, s, e, n] of tile.legs) {
      if (!legs.has(id)) legs.set(id, { a, b, id, km, bounds: [w, s, e, n] })
    }
  }
  return { nodes, legs: [...legs.values()] }
}

function readLeg(id: number): LegWay[] | null {
  const held = legMemory.get(id)
  if (held) return held
  try {
    const raw = localStorage.getItem(LEG_PREFIX + id)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { at: number; data: LegWay[] }
    if (!Array.isArray(parsed?.data) || Date.now() - parsed.at > LEG_TTL_MS) return null
    legMemory.set(id, parsed.data)
    return parsed.data
  } catch {
    return null
  }
}

function writeLeg(id: number, ways: LegWay[]) {
  legMemory.set(id, ways)
  try {
    localStorage.setItem(LEG_PREFIX + id, JSON.stringify({ at: Date.now(), data: ways }))
  } catch {
    /* quota — the in-memory copy still serves this session */
  }
}

interface OsmElement {
  type: string
  id: number
  lat?: number
  lon?: number
  nodes?: number[]
  role?: string
  members?: { type: string; ref?: number; role?: string; geometry?: { lat: number; lon: number }[] }[]
}

/**
 * A leg's ways out of the OSM API's `relation/{id}/full`: the relation, its
 * ways, and every node those ways use, as three flat lists to be joined.
 */
export function legWaysFromOsm(json: { elements?: OsmElement[] }, id: number): LegWay[] {
  const elements = json.elements ?? []
  const at = new Map<number, LngLat>()
  const ways = new Map<number, number[]>()
  let relation: OsmElement | undefined
  for (const el of elements) {
    if (el.type === 'node' && el.lat != null && el.lon != null) at.set(el.id, [el.lon, el.lat])
    else if (el.type === 'way' && el.nodes) ways.set(el.id, el.nodes)
    else if (el.type === 'relation' && el.id === id) relation = el
  }
  const out: LegWay[] = []
  for (const m of relation?.members ?? []) {
    if (m.type !== 'way' || m.ref == null) continue
    const points = (ways.get(m.ref) ?? [])
      .map((n) => at.get(n))
      .filter((p): p is LngLat => !!p)
    if (points.length > 1) out.push({ role: m.role ?? '', points })
  }
  return out
}

async function legFromOsm(id: number, signal?: AbortSignal): Promise<LegWay[]> {
  const res = await fetch(`${OSM_API}/relation/${id}/full.json`, { signal })
  if (!res.ok) throw new Error(`OSM API answered ${res.status}`)
  return legWaysFromOsm(await res.json(), id)
}

/** Ask each Overpass mirror in turn, each for so long, unless the caller gave up. */
async function askOverpass(body: string, signal?: AbortSignal) {
  let last: unknown = null
  for (const url of OVERPASS_MIRRORS) {
    const attempt = new AbortController()
    const giveUp = () => attempt.abort()
    signal?.addEventListener('abort', giveUp)
    const timer = setTimeout(giveUp, ASK_TIMEOUT_MS)
    try {
      const res = await fetch(url, { method: 'POST', body, signal: attempt.signal })
      if (res.ok) return await res.json()
      last = new Error(`Overpass failed (${res.status})`)
    } catch (err) {
      if (signal?.aborted) throw err
      last = err
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', giveUp)
    }
  }
  throw last ?? new Error('Overpass unreachable')
}

async function legsFromOverpass(ids: number[], signal?: AbortSignal): Promise<Map<number, LegWay[]>> {
  const query = `[out:json][timeout:25];relation(id:${ids.join(',')});out geom;`
  const json = await askOverpass(query, signal)
  const out = new Map<number, LegWay[]>()
  for (const el of (json.elements ?? []) as OsmElement[]) {
    if (el.type !== 'relation' || !el.members) continue
    const ways: LegWay[] = el.members
      .filter((m) => m.type === 'way' && m.geometry && m.geometry.length > 1)
      .map((m) => ({
        role: m.role ?? '',
        points: m.geometry!.map((p) => [p.lon, p.lat] as LngLat),
      }))
    out.set(el.id, ways)
  }
  return out
}

/**
 * The ways of the given legs, by relation id, ready for stitching.
 *
 * The OSM API first, a few legs at a time; whatever it could not deliver is
 * asked of Overpass in one batch. Every answer is kept.
 */
export async function fetchLegGeometry(
  ids: number[],
  signal?: AbortSignal,
): Promise<Map<number, LegWay[]>> {
  const out = new Map<number, LegWay[]>()
  let missing: number[] = []
  for (const id of ids) {
    const cached = readLeg(id)
    if (cached) out.set(id, cached)
    else missing.push(id)
  }

  for (let i = 0; i < missing.length; i += PARALLEL) {
    const batch = missing.slice(i, i + PARALLEL)
    const answers = await Promise.allSettled(batch.map((id) => legFromOsm(id, signal)))
    answers.forEach((answer, j) => {
      if (answer.status === 'fulfilled') out.set(batch[j], answer.value)
    })
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  }
  missing = missing.filter((id) => !out.has(id))

  if (missing.length) {
    const rest = await legsFromOverpass(missing, signal)
    for (const [id, ways] of rest) out.set(id, ways)
  }

  for (const id of ids) {
    const ways = out.get(id)
    if (ways && !legMemory.has(id)) writeLeg(id, ways)
  }
  return out
}
