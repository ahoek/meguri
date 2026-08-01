import { distanceKm } from './geo.js'

const OVERPASS = 'https://overpass-api.de/api/interpreter'
const SEARCH_RADIUS_M = 130
const MAX_SPOTS = 8

// A windmill is worth a detour; the third piece of a twenty-part sculpture
// series is not. Used to choose a winner when several spots compete.
const KIND_SCORE = {
  viewpoint: 5,
  windmill: 5,
  water: 4,
  nature: 4,
  museum: 4,
  heritage: 3,
  park: 3,
  picnic: 3,
  artwork: 2,
}

// Only things worth looking up from the saddle or the pavement. Anything
// generic (shops, benches, bus stops) would bury the map in noise.
const KINDS = [
  { key: 'viewpoint', match: (t) => t.tourism === 'viewpoint' || t.man_made === 'tower' },
  { key: 'artwork', match: (t) => t.tourism === 'artwork' || t.tourism === 'gallery' },
  {
    key: 'water',
    match: (t) =>
      ['waterfall', 'spring', 'beach', 'bay'].includes(t.natural) ||
      t.leisure === 'swimming_area',
  },
  {
    key: 'nature',
    match: (t) =>
      t.leisure === 'nature_reserve' ||
      ['peak', 'cliff', 'cave_entrance', 'tree'].includes(t.natural),
  },
  { key: 'park', match: (t) => ['park', 'garden'].includes(t.leisure) },
  {
    key: 'picnic',
    match: (t) => t.tourism === 'picnic_site' || t.leisure === 'picnic_table',
  },
  { key: 'museum', match: (t) => t.tourism === 'museum' },
  { key: 'heritage', match: (t) => !!t.historic || t.building === 'church' },
  {
    key: 'windmill',
    match: (t) => ['windmill', 'watermill', 'lighthouse'].includes(t.man_made),
  },
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
    'node(around:R)["tourism"~"^(viewpoint|artwork|picnic_site|museum|gallery)$"]',
    'way(around:R)["tourism"~"^(viewpoint|artwork|picnic_site|museum|gallery)$"]',
    'node(around:R)["historic"]',
    'way(around:R)["historic"]',
    'node(around:R)["natural"~"^(waterfall|spring|peak|cliff|cave_entrance)$"]',
    'way(around:R)["natural"~"^(beach|bay)$"]',
    'node(around:R)["man_made"~"^(windmill|watermill|lighthouse|tower)$"]',
    'way(around:R)["man_made"~"^(windmill|watermill|lighthouse|tower)$"]',
    'way(around:R)["leisure"~"^(park|garden|nature_reserve|swimming_area)$"]',
  ]
    .map((f) => f.replace('around:R', `around:${SEARCH_RADIUS_M},${around}`) + ';')
    .join('\n  ')
  return `[out:json][timeout:25];\n(\n  ${filters}\n);\nout center tags 120;`
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
    if (near.distanceKm * 1000 > SEARCH_RADIUS_M * 1.5) continue

    spots.push({
      id: `${el.type}/${el.id}`,
      name,
      kind,
      lngLat,
      atKm: near.atKm,
      description: tags.description || tags['description:' + lang] || null,
    })
  }

  return spread(spots, prepared.totalKm)
}

/** Strip a trailing "3/20" so one sculpture series counts as one thing. */
function nameKey(name) {
  return name
    .toLowerCase()
    .replace(/[\s\-–]*\d+\s*[/of]*\s*\d*\s*$/, '')
    .trim()
}

/**
 * Pick a readable handful: divide the route into equal stretches and keep the
 * most interesting spot in each, so pins are spread out rather than piled on
 * whichever corner happens to be richest.
 */
function spread(spots, totalKm) {
  const bucketKm = Math.max(0.4, totalKm / MAX_SPOTS)
  const best = new Map()
  const seenNames = new Set()

  for (const spot of spots.sort((a, b) => a.atKm - b.atKm)) {
    const key = nameKey(spot.name)
    if (seenNames.has(key)) continue

    const bucket = Math.floor(spot.atKm / bucketKm)
    const held = best.get(bucket)
    const score = KIND_SCORE[spot.kind] ?? 1
    if (!held || score > held.score) {
      if (held) seenNames.delete(nameKey(held.spot.name))
      best.set(bucket, { spot, score })
      seenNames.add(key)
    }
  }

  return [...best.values()]
    .map((entry) => entry.spot)
    .sort((a, b) => a.atKm - b.atKm)
    .slice(0, MAX_SPOTS)
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
