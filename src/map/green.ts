import type maplibregl from 'maplibre-gl'
import type { LngLat } from '../domain/geo'

/**
 * Move a point onto nearby green.
 *
 * The loop's via points sit on a circle, which is what makes it come back the
 * right length without doubling over itself. Nothing said they have to sit on it
 * *exactly*, and a via point nudged a couple of hundred metres onto the nearest
 * park drags the whole leg through it.
 *
 * Two earlier attempts at this failed and are worth recording, because both were
 * more obvious than the thing that works:
 *
 * 1. Score candidates on measured greenness and keep the greenest. Better than
 *    luck, but greenness fights overlap — a park has fewer paths, so a route
 *    through it doubles back more — and overlap is weighted sixteen times
 *    heavier. The green candidate loses on the very thing that makes it green.
 * 2. Aim the whole loop at the biggest green mass nearby. At Yoyogi that pointed
 *    north-northwest at Meiji Jingu's woods when the walkable green was west, so
 *    it was worse than random. One direction for the whole loop is too blunt.
 *
 * Nudging each point separately has neither problem: it is local, so no distant
 * blob can outvote the park across the road, and it moves the route into green
 * instead of asking the scorer to prefer green after the fact.
 */

// The layers the basemap already styles as countryside. Tiles carry these
// everywhere OpenMapTiles does, so this is not a Netherlands-only trick — but NL
// is where it matters most, where "nature" is usually a specific polygon a few
// streets away rather than a wilderness you are already in.
const GREEN_LAYERS = [
  { layer: 'landcover_wood', sourceLayer: 'landcover', cls: 'wood' },
  { layer: 'landcover_grass', sourceLayer: 'landcover', cls: 'grass' },
  { layer: 'park', sourceLayer: 'park', cls: null },
]

const M_PER_DEG_LAT = 111_320

// Green smaller than this is a verge or a roundabout, not somewhere to walk.
const MIN_AREA_M2 = 5_000

type Ring = [number, number][]

function ringsOf(geometry: { type: string; coordinates: unknown }): Ring[] {
  if (geometry.type === 'Polygon') return geometry.coordinates as Ring[]
  if (geometry.type === 'MultiPolygon') {
    return (geometry.coordinates as Ring[][]).flatMap((poly) => poly)
  }
  return []
}

/** Centroid and area of a ring in metres, via the shoelace formula. */
function ringMetrics(ring: Ring, perDegLng: number) {
  let twiceArea = 0
  let cx = 0
  let cy = 0
  for (let i = 0; i < ring.length - 1; i++) {
    const x1 = ring[i][0] * perDegLng
    const y1 = ring[i][1] * M_PER_DEG_LAT
    const x2 = ring[i + 1][0] * perDegLng
    const y2 = ring[i + 1][1] * M_PER_DEG_LAT
    const cross = x1 * y2 - x2 * y1
    twiceArea += cross
    cx += (x1 + x2) * cross
    cy += (y1 + y2) * cross
  }
  if (twiceArea === 0) return null
  return {
    area: Math.abs(twiceArea / 2),
    lng: cx / (3 * twiceArea) / perDegLng,
    lat: cy / (3 * twiceArea) / M_PER_DEG_LAT,
  }
}

/**
 * Every patch of green the loaded tiles know about.
 *
 * Not filtered by reach, and that is the point: `nudgeToGreen` already drops
 * anything further than the via point may travel, so one collection serves
 * every point of every attempt. Filtering here instead meant collecting per
 * point — `querySourceFeatures` walking every loaded tile, and the ring
 * metrics over all of it, four to seven times per attempt across up to seven
 * attempts. The doc comment claimed once per generate; the wiring never was.
 *
 * The metric scale comes from the map's centre rather than from each point.
 * Centroids are unaffected — the longitude scale cancels out of the shoelace
 * quotient — and area only feeds a cube-rooted tie-break, so a cosine that is
 * a few kilometres out of place cannot change which patch wins.
 */
export function collectGreen(map: maplibregl.Map) {
  const perDegLng = M_PER_DEG_LAT * Math.cos((map.getCenter().lat * Math.PI) / 180)
  const patches: { lng: number; lat: number; area: number }[] = []

  for (const { layer, sourceLayer, cls } of GREEN_LAYERS) {
    if (!map.getLayer(layer)) continue
    let features: maplibregl.GeoJSONFeature[]
    try {
      features = map.querySourceFeatures('openmaptiles', { sourceLayer })
    } catch {
      continue
    }
    for (const feature of features) {
      if (cls && feature.properties?.class !== cls) continue
      for (const ring of ringsOf(feature.geometry as { type: string; coordinates: unknown })) {
        const m = ringMetrics(ring, perDegLng)
        if (!m || m.area < MIN_AREA_M2) continue
        patches.push(m)
      }
    }
  }
  return patches
}

export type GreenPatches = ReturnType<typeof collectGreen>

/**
 * The nearest green worth diverting to, or null to leave the point where it is.
 *
 * Bigger patches win a tie so the loop is pulled to the park rather than the
 * lawn beside it, but distance dominates — dragging a via point right across
 * town would wreck the loop's shape and its length.
 */
export function nudgeToGreen(
  point: LngLat,
  patches: GreenPatches,
  maxMoveM: number,
): LngLat | null {
  const perDegLng = M_PER_DEG_LAT * Math.cos((point[1] * Math.PI) / 180)
  let best: { lng: number; lat: number } | null = null
  let bestCost = Infinity
  for (const patch of patches) {
    const away = Math.hypot(
      (patch.lng - point[0]) * perDegLng,
      (patch.lat - point[1]) * M_PER_DEG_LAT,
    )
    if (away > maxMoveM) continue
    // Distance first; a patch ten times the area is worth about a third further.
    const cost = away / Math.cbrt(patch.area)
    if (cost < bestCost) {
      bestCost = cost
      best = patch
    }
  }
  return best ? [best.lng, best.lat] : null
}

/**
 * A nudger over the green the map currently holds, collected once and kept
 * until tiles change — the same arrangement, and for the same reason, as the
 * building meter beside it.
 */
export function createGreenNudger(map: maplibregl.Map) {
  let patches: GreenPatches = []
  let stale = true

  map.on('sourcedata', (e) => {
    if (e.sourceId === 'openmaptiles') stale = true
  })

  return (point: LngLat, maxMoveM: number) => {
    if (stale) {
      patches = collectGreen(map)
      stale = false
    }
    return nudgeToGreen(point, patches, maxMoveM)
  }
}
