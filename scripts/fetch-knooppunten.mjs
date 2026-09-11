// Build the static junction-network tiles the app plans knooppunten rides on.
//
// Run: node scripts/fetch-knooppunten.mjs [lat_lng ...]
//
// The Dutch, Belgian and border-German cycling node network — every numbered
// junction, and every signposted leg between two of them with its ridden
// length — is a few megabytes, and it changes about as often as roads are
// rebuilt. Asking Overpass for it at plan time made the planner hostage to
// a shared free service that allows two concurrent queries per address:
// tested from one flat with two browsers open, it answered 429. So the
// network is fetched here, once, and shipped with the app as tiles of half
// a degree; at plan time the app reads the two to four tiles under the ride
// and never asks Overpass for anything but the chosen legs' geometry — and
// even that goes to the OSM API first.
//
// Each leg: [from, to, relation id, km, west, south, east, north].
//
// A leg's length is the sum of its member ways ridden in one direction:
// `length()` on the relation itself counts both sides of a split cycle
// path, which measured up to double the real leg (5.8 km tagged, 2.9 km
// ridden) and sent every ride short.

import { mkdir, writeFile } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const OUT_DIR = new URL('../public/knooppunten/', import.meta.url)
// The Low Countries, with the German and French border regions that carry
// the network too. Must agree with `inNetworkCountries` in the domain.
const REGION = { south: 49, west: 2, north: 54, east: 8 }
// Half a degree: roughly 55 km north to south, 34 km east to west here.
// Must agree with TILE in src/infra/knooppunten.ts.
export const TILE = 0.5

const MIRRORS = [
  'https://overpass.openstreetmap.fr/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
]

const tileKey = (lat, lng) => `${lat.toFixed(1)}_${lng.toFixed(1)}`

function query(south, west, north, east) {
  const box = `${south},${west},${north},${east}`
  return (
    `[out:json][timeout:180];` +
    `node["network:type"="node_network"]["rcn_ref"](${box});out skel qt;` +
    `relation["network:type"="node_network"]["network"="rcn"]["route"="bicycle"](${box})->.r;` +
    `.r out bb;way(r.r);convert way ::id=id(),len=length();out;`
  )
}

async function ask(body) {
  let last
  for (const url of MIRRORS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        // The main server answers 406 to Node's default text/plain body and
        // the French mirror 403 to a missing agent; curl sends both.
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'meguri-knooppunten-build (https://github.com/arthurhoek/meguri)',
        },
        signal: AbortSignal.timeout(240_000),
      })
      if (res.ok) return await res.json()
      last = new Error(`${url} answered ${res.status}`)
    } catch (err) {
      last = err
    }
    console.warn(`  ${last.message ?? last}; trying the next mirror`)
  }
  throw last
}

/** Nodes need their tags, which `skel` drops; ask for them in the same tile. */
function nodeQuery(south, west, north, east) {
  return (
    `[out:json][timeout:180];` +
    `node["network:type"="node_network"]["rcn_ref"](${south},${west},${north},${east});out qt;`
  )
}

async function buildTile(lat, lng) {
  const south = lat
  const west = lng
  const north = +(lat + TILE).toFixed(1)
  const east = +(lng + TILE).toFixed(1)

  const nodesJson = await ask(nodeQuery(south, west, north, east))
  const nodes = (nodesJson.elements ?? [])
    .filter((n) => n.type === 'node' && n.tags?.rcn_ref)
    .map((n) => [n.tags.rcn_ref, +n.lon.toFixed(5), +n.lat.toFixed(5)])
  if (!nodes.length) return null

  const legsJson = await ask(query(south, west, north, east))
  const wayKm = new Map()
  const relations = []
  for (const el of legsJson.elements ?? []) {
    if (el.type === 'way') wayKm.set(el.id, Number(el.tags?.len) / 1000)
    else if (el.type === 'relation') relations.push(el)
  }

  const legs = []
  for (const rel of relations) {
    const match = /^(\S+)-(\S+)$/.exec(rel.tags?.ref ?? '')
    if (!match) continue
    let km = 0
    for (const m of rel.members ?? []) {
      if (m.type !== 'way' || m.role === 'backward') continue
      km += wayKm.get(m.ref) ?? 0
    }
    // The leg's bounds travel with it: numbers repeat from one region to the
    // next, and with a few tiles loaded a "23-80" forty kilometres away was
    // being attached to a 23 and an 80 that happened to sit within its
    // length of each other. The junctions a leg joins lie inside its box.
    const b = rel.bounds
    if (!b || !(km > 0)) continue
    const r4 = (n) => +n.toFixed(4)
    legs.push([match[1], match[2], rel.id, +km.toFixed(3), r4(b.minlon), r4(b.minlat), r4(b.maxlon), r4(b.maxlat)])
  }
  return { nodes, legs }
}

async function main() {
  const only = new Set(process.argv.slice(2))
  await mkdir(OUT_DIR, { recursive: true })
  const at = new Date().toISOString().slice(0, 10)
  const written = []
  for (let lat = REGION.south; lat < REGION.north; lat = +(lat + TILE).toFixed(1)) {
    for (let lng = REGION.west; lng < REGION.east; lng = +(lng + TILE).toFixed(1)) {
      const key = tileKey(lat, lng)
      if (only.size && !only.has(key)) continue
      process.stdout.write(`${key} … `)
      const tile = await buildTile(lat, lng)
      if (!tile) {
        console.log('empty')
        continue
      }
      const file = new URL(`${key}.json`, OUT_DIR)
      const json = JSON.stringify({ at, ...tile })
      await writeFile(file, json)
      console.log(`${tile.nodes.length} junctions, ${tile.legs.length} legs, ${(json.length / 1024).toFixed(0)} KB`)
      written.push(key)
      await sleep(1500) // a shared service; no need to lean on it
    }
  }
  await writeFile(new URL('tiles.json', OUT_DIR), JSON.stringify({ at, tile: TILE, tiles: written }))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
