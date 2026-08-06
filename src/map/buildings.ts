import type maplibregl from 'maplibre-gl'
import type { LngLat } from '../domain/geo'

/**
 * How many metres of a route run through buildings.
 *
 * A route can only follow ways OSM knows, and now and then OSM knows a way
 * that is not there — a passage mapped through a block that was rebuilt, a
 * corridor that is really someone's shop. The router cannot tell, but the map
 * can: the same tiles that draw the buildings say whether a stretch of route
 * is inside one. Candidates that thread a building lose to candidates that
 * do not, which is as much as the app can do about wrong data — when every
 * candidate the router offers goes through, the fix is editing OSM, not
 * scoring.
 *
 * Null when no footprints are loaded, which cannot be told apart from open
 * country with no buildings at all — but in open country there is nothing to
 * cross either, so "unmeasured" and "zero" only differ where it doesn't
 * matter. Buildings exist in tiles from about z13; the planner is usually
 * looking at the area it plans in.
 */
const M_PER_DEG_LAT = 111_320

type Ring = [number, number][]

function ringsOf(geometry: { type: string; coordinates: unknown }): Ring[][] {
  if (geometry.type === 'Polygon') return [geometry.coordinates as Ring[]]
  if (geometry.type === 'MultiPolygon') return geometry.coordinates as Ring[][]
  return []
}

function inRing(pt: LngLat, ring: Ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (
      yi > pt[1] !== yj > pt[1] &&
      pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside
    }
  }
  return inside
}

// A courtyard is not a building: a point inside the outer ring but also
// inside a hole is outside the footprint.
function inFootprint(pt: LngLat, rings: Ring[]) {
  return inRing(pt, rings[0]) && !rings.slice(1).some((hole) => inRing(pt, hole))
}

// Sampled rather than intersected: exact segment-polygon clipping buys
// nothing here, since anything long enough to matter is caught by three
// samples, and anything three samples miss is a graze.
const SAMPLES = [0.25, 0.5, 0.75]

export function metresThroughBuildings(
  map: maplibregl.Map,
  coords: LngLat[],
): number | null {
  let footprints: Ring[][] = []
  try {
    for (const f of map.querySourceFeatures('openmaptiles', {
      sourceLayer: 'building',
    })) {
      footprints = footprints.concat(
        ringsOf(f.geometry as { type: string; coordinates: unknown }),
      )
    }
  } catch {
    return null
  }
  if (!footprints.length) return null

  let metres = 0
  for (let i = 1; i < coords.length; i++) {
    const hit = SAMPLES.some((t) => {
      const pt: LngLat = [
        coords[i - 1][0] + (coords[i][0] - coords[i - 1][0]) * t,
        coords[i - 1][1] + (coords[i][1] - coords[i - 1][1]) * t,
      ]
      return footprints.some((rings) => inFootprint(pt, rings))
    })
    if (!hit) continue
    const perDegLng = M_PER_DEG_LAT * Math.cos((coords[i][1] * Math.PI) / 180)
    metres += Math.hypot(
      (coords[i][0] - coords[i - 1][0]) * perDegLng,
      (coords[i][1] - coords[i - 1][1]) * M_PER_DEG_LAT,
    )
  }
  return metres
}
