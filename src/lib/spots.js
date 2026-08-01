import { distanceKm } from './geo.js'

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const SEARCH_RADIUS_M = 70
const MAX_SPOTS = 14
const MIN_GAP_KM = 0.25 // don't cluster several pins on the same corner

// Only things worth looking up from the saddle or the pavement. Anything
// generic (shops, benches, bus stops) would bury the map in noise.
const KINDS = [
  { key: 'viewpoint', match: (t) => t.tourism === 'viewpoint' },
  { key: 'artwork', match: (t) => t.tourism === 'artwork' },
  { key: 'water', match: (t) => t.natural === 'waterfall' || t.natural === 'spring' },
  { key: 'nature', match: (t) => t.leisure === 'nature_reserve' || t.natural === 'peak' },
  { key: 'park', match: (t) => t.leisure === 'park' || t.leisure === 'garden' },
  { key: 'picnic', match: (t) => t.tourism === 'picnic_site' || t.amenity === 'shelter' },
  { key: 'heritage', match: (t) => !!t.historic },
  { key: 'windmill', match: (t) => t.man_made === 'windmill' || t.man_made === 'watermill' },
]

function classify(tags) {
  return KINDS.find((kind) => kind.match(tags))?.key ?? null
}

/** Thin the route down to query anchors roughly every 250 m. */
function anchors(coords, cumulative) {
  const picked = []
  let nextAt = 0
  for (let i = 0; i < coords.length; i++) {
    if (cumulative[i] >= nextAt) {
      picked.push(coords[i])
      nextAt = cumulative[i] + 0.25
    }
  }
  return picked
}

function buildQuery(points) {
  const around = points
    .map(([lng, lat]) => `${lat.toFixed(5)},${lng.toFixed(5)}`)
    .join(',')
  const filters = [
    'node(around:R)["tourism"~"^(viewpoint|artwork|picnic_site)$"]',
    'node(around:R)["historic"]',
    'node(around:R)["natural"~"^(waterfall|spring|peak)$"]',
    'node(around:R)["man_made"~"^(windmill|watermill)$"]',
    'way(around:R)["leisure"~"^(park|garden|nature_reserve)$"]',
  ]
    .map((f) => f.replace('around:R', `around:${SEARCH_RADIUS_M},${around}`) + ';')
    .join('\n  ')
  return `[out:json][timeout:20];\n(\n  ${filters}\n);\nout center tags 60;`
}

/**
 * Find a handful of interesting places along a route.
 *
 * Best-effort: Overpass is a shared free service, so any failure or timeout
 * resolves to an empty list rather than disturbing the route itself.
 */
export async function findSpots(prepared, { signal, lang = 'en' } = {}) {
  try {
    const query = buildQuery(anchors(prepared.coords, prepared.cumulative))
    const res = await fetch(OVERPASS, {
      method: 'POST',
      body: query,
      signal,
    })
    if (!res.ok) return []
    const data = await res.json()
    return rank(data.elements ?? [], prepared, lang)
  } catch {
    return []
  }
}

function rank(elements, prepared, lang) {
  const spots = []

  for (const el of elements) {
    const tags = el.tags ?? {}
    const name = tags[`name:${lang}`] || tags.name
    if (!name) continue // an unnamed pin tells the walker nothing

    const kind = classify(tags)
    if (!kind) continue

    const lngLat = el.type === 'node' ? [el.lon, el.lat] : [el.center?.lon, el.center?.lat]
    if (lngLat[0] == null) continue

    const near = nearestOnRoute(prepared, lngLat)
    if (near.distanceKm * 1000 > SEARCH_RADIUS_M * 2) continue

    spots.push({
      id: `${el.type}/${el.id}`,
      name,
      kind,
      lngLat,
      atKm: near.atKm,
      description: tags.description || tags['description:' + lang] || null,
    })
  }

  spots.sort((a, b) => a.atKm - b.atKm)

  // Spread them out so the route isn't dotted with pins in one spot.
  const spaced = []
  for (const spot of spots) {
    const last = spaced[spaced.length - 1]
    if (!last || spot.atKm - last.atKm >= MIN_GAP_KM) spaced.push(spot)
  }
  return spaced.slice(0, MAX_SPOTS)
}

function nearestOnRoute(prepared, lngLat) {
  let best = Infinity
  let atKm = 0
  for (let i = 0; i < prepared.coords.length; i++) {
    const d = distanceKm(prepared.coords[i], lngLat)
    if (d < best) {
      best = d
      atKm = prepared.cumulative[i]
    }
  }
  return { distanceKm: best, atKm }
}

/** The spot just ahead of the walker, within `withinM`. */
export function upcomingSpot(spots, alongKm, withinM = 180) {
  for (const spot of spots) {
    const deltaM = (spot.atKm - alongKm) * 1000
    if (deltaM > -40 && deltaM < withinM) {
      return { ...spot, distanceM: Math.max(0, deltaM) }
    }
  }
  return null
}
