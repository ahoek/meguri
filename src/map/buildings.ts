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

function inRing(x: number, y: number, ring: Ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0]
    const yi = ring[i][1]
    const xj = ring[j][0]
    const yj = ring[j][1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

// A courtyard is not a building: a point inside the outer ring but also
// inside a hole is outside the footprint.
function inFootprint(x: number, y: number, rings: Ring[]) {
  if (!inRing(x, y, rings[0])) return false
  for (let h = 1; h < rings.length; h++) {
    if (inRing(x, y, rings[h])) return false
  }
  return true
}

/** One footprint, with the box it lives in so most tests can stop at a compare. */
interface Footprint {
  rings: Ring[]
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * The loaded footprints, bucketed by a grid of cells, because the obvious
 * version of this was the app's worst stall by an order of magnitude.
 *
 * Asking every footprint about every sample point is quadratic in two things
 * that both get big: a phone at z14 holds a few thousand polygons — OpenMapTiles
 * hands buildings over as heavily aggregated MultiPolygons, so sixty-seven
 * *features* were measured to carry six and a half thousand rings — and a loop
 * is scored up to seven times per plan. Measured on a real 7.6 km walk in a
 * Dutch suburb, one call took 833 ms on a fast desktop, and 5.9 seconds with a
 * desktop's worth of tiles loaded. That is the freeze, seven times over: on a
 * phone it is most of a minute of dead main thread, which is where the sliders
 * and the breathing route line went.
 *
 * A grid fixes it because buildings are tiny and scattered: a point's cell
 * holds a handful of candidates instead of thousands, and the box test throws
 * out most of those before any ring is walked.
 */
// About 220 m north-south — comfortably larger than any building, so a
// footprint lands in one cell or two and the buckets stay short.
const CELL_DEG = 0.002

type Grid = Map<string, Footprint[]>

const cellKey = (x: number, y: number) =>
  `${Math.floor(x / CELL_DEG)}:${Math.floor(y / CELL_DEG)}`

function buildGrid(map: maplibregl.Map): Grid | null {
  let features: maplibregl.GeoJSONFeature[]
  try {
    features = map.querySourceFeatures('openmaptiles', { sourceLayer: 'building' })
  } catch {
    return null
  }

  const grid: Grid = new Map()
  let count = 0
  // Indexed loops, not for-of with destructuring: this walks about fifty
  // thousand ring points, and measured on that data the idiomatic
  // `for (const [x, y] of ring)` cost 38 ms against 1.4 ms for the same work
  // read by index — the iterator and the pair it unpacks are allocated per
  // point. Everywhere else in the app the readable form is the right one.
  for (let f = 0; f < features.length; f++) {
    const polygons = ringsOf(
      features[f].geometry as { type: string; coordinates: unknown },
    )
    for (let p = 0; p < polygons.length; p++) {
      const rings = polygons[p]
      const outer = rings[0]
      if (!outer?.length) continue
      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      for (let i = 0; i < outer.length; i++) {
        const x = outer[i][0]
        const y = outer[i][1]
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
      const footprint: Footprint = { rings, minX, minY, maxX, maxY }
      count += 1
      const gx1 = Math.floor(minX / CELL_DEG)
      const gx2 = Math.floor(maxX / CELL_DEG)
      const gy1 = Math.floor(minY / CELL_DEG)
      const gy2 = Math.floor(maxY / CELL_DEG)
      for (let gx = gx1; gx <= gx2; gx++) {
        for (let gy = gy1; gy <= gy2; gy++) {
          const key = `${gx}:${gy}`
          const bucket = grid.get(key)
          if (bucket) bucket.push(footprint)
          else grid.set(key, [footprint])
        }
      }
    }
  }
  return count ? grid : null
}

function insideAny(grid: Grid, x: number, y: number) {
  const bucket = grid.get(cellKey(x, y))
  if (!bucket) return false
  for (const f of bucket) {
    if (x < f.minX || x > f.maxX || y < f.minY || y > f.maxY) continue
    if (inFootprint(x, y, f.rings)) return true
  }
  return false
}

// Sampled rather than intersected: exact segment-polygon clipping buys
// nothing here, since anything long enough to matter is caught by three
// samples, and anything three samples miss is a graze.
const SAMPLES = [0.25, 0.5, 0.75]

/**
 * A meter over the footprints the map currently holds.
 *
 * The index is built on demand and kept until tiles change, so the seven
 * candidates of one plan share the one build rather than each paying for their
 * own. Panning or zooming marks it stale; nothing is rebuilt until something
 * asks again, so a drag across town costs nothing on its own.
 */
export function createBuildingMeter(map: maplibregl.Map) {
  let grid: Grid | null = null
  let stale = true

  // Basemap tiles only. The route's own GeoJSON sources fire this event on
  // every frame of the draw-in, and rebuilding the index sixty times a second
  // would be its own stall.
  map.on('sourcedata', (e) => {
    if (e.sourceId === 'openmaptiles') stale = true
  })

  return (coords: LngLat[]): number | null => {
    if (stale) {
      grid = buildGrid(map)
      stale = false
    }
    if (!grid) return null

    let metres = 0
    for (let i = 1; i < coords.length; i++) {
      const ax = coords[i - 1][0]
      const ay = coords[i - 1][1]
      const bx = coords[i][0]
      const by = coords[i][1]
      let hit = false
      for (const t of SAMPLES) {
        if (insideAny(grid, ax + (bx - ax) * t, ay + (by - ay) * t)) {
          hit = true
          break
        }
      }
      if (!hit) continue
      const perDegLng = M_PER_DEG_LAT * Math.cos((by * Math.PI) / 180)
      metres += Math.hypot((bx - ax) * perDegLng, (by - ay) * M_PER_DEG_LAT)
    }
    return metres
  }
}
