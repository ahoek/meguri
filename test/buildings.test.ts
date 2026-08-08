import { describe, expect, it } from 'vitest'
import { createBuildingMeter } from '../src/map/buildings'
import { ORIGIN, offset, M_PER_DEG_LAT, M_PER_DEG_LNG } from './helpers'
import type { LngLat } from '../src/domain/geo'

/**
 * The meter reads footprints out of the map's loaded tiles, so tests hand it a
 * stub map — the same arrangement the domain uses for the router. Only two
 * methods are ever touched: `querySourceFeatures` for the polygons and `on` to
 * hear that tiles changed.
 */
function stubMap(polygons: LngLat[][][], { listeners = [] as (() => void)[] } = {}) {
  let queries = 0
  const map = {
    querySourceFeatures: () => {
      queries += 1
      return polygons.map((rings) => ({
        geometry: { type: 'Polygon', coordinates: rings },
        properties: {},
      }))
    },
    on: (event: string, fn: (e: { sourceId: string }) => void) => {
      if (event === 'sourcedata') listeners.push(() => fn({ sourceId: 'openmaptiles' }))
    },
    queries: () => queries,
  }
  return map as typeof map & Record<string, unknown>
}

/** An axis-aligned rectangle in metres east/north of ORIGIN, as a closed ring. */
function ring(eastM: number, northM: number, widthM: number, heightM: number): LngLat[] {
  const a = offset(ORIGIN, eastM, northM)
  const b = offset(ORIGIN, eastM + widthM, northM + heightM)
  return [a, [b[0], a[1]], b, [a[0], b[1]], a]
}

/** The same rectangle as a whole footprint — one solid ring, no courtyard. */
const box = (
  eastM: number,
  northM: number,
  widthM: number,
  heightM: number,
): LngLat[][] => [ring(eastM, northM, widthM, heightM)]

// The stub's metre-per-degree constants are the helpers' approximations, and
// the meter uses a real cosine for longitude, so lengths land within a percent
// or two rather than exactly. Distances here are checked loosely on purpose.
const eastward = (fromM: number, toM: number): LngLat[] => [
  offset(ORIGIN, fromM, 0),
  offset(ORIGIN, toM, 0),
]

describe('metres of a route running through buildings', () => {
  it('finds nothing when the route passes beside the footprints', () => {
    // A block 50 m north of a route running due east along ORIGIN's latitude.
    const meter = createBuildingMeter(stubMap([box(0, 50, 100, 40)]) as never)
    expect(meter(eastward(0, 200))).toBe(0)
  })

  it('charges the segment that threads a footprint', () => {
    const meter = createBuildingMeter(stubMap([box(20, -20, 100, 40)]) as never)
    // The whole 200 m segment is charged: a segment either grazes or it doesn't,
    // and one that does is not sliced at the wall.
    const through = meter(eastward(0, 200))
    expect(through).toBeGreaterThan(190)
    expect(through).toBeLessThan(210)
  })

  it('reports null when the tiles hold no footprints at all', () => {
    // Not zero: no polygons loaded cannot be told apart from open country, and
    // the scorer must not read "unmeasured" as "clean".
    const meter = createBuildingMeter(stubMap([]) as never)
    expect(meter(eastward(0, 200))).toBeNull()
  })

  it('treats a courtyard as outside the building', () => {
    const outer = ring(-100, -100, 200, 200)
    const hole = ring(-40, -40, 80, 80)
    // The route runs straight through the middle of the hole, which is open air.
    const meter = createBuildingMeter(stubMap([[outer, hole]]) as never)
    expect(meter(eastward(-20, 20))).toBe(0)
    // And through the solid part either side of it.
    expect(meter(eastward(-90, -60))).toBeGreaterThan(0)
  })

  it('finds footprints wherever they sit relative to the grid it buckets them into', () => {
    // A footprint straddling a cell boundary must be found from either side —
    // the reason each one is filed under every cell its box touches. The cells
    // are 0.002°, so this walks a route across several of them.
    const boxes: LngLat[][][] = []
    for (let i = 0; i < 12; i++) boxes.push(box(i * 250 + 100, -20, 60, 40))
    const meter = createBuildingMeter(stubMap(boxes) as never)
    for (let i = 0; i < 12; i++) {
      const at = i * 250 + 130
      expect(meter(eastward(at - 10, at + 10)), `box ${i}`).toBeGreaterThan(0)
    }
  })

  it('scans the tiles once and reuses the index across a plan’s candidates', () => {
    // Seven candidates per plan, each a separate call: the scan they share is
    // the whole reason this is an index and not a loop over every polygon.
    const map = stubMap([box(20, -20, 100, 40)])
    const meter = createBuildingMeter(map as never)
    for (let i = 0; i < 7; i++) meter(eastward(0, 200))
    expect(map.queries()).toBe(1)
  })

  it('rescans once new tiles arrive', () => {
    const listeners: (() => void)[] = []
    const map = stubMap([box(20, -20, 100, 40)], { listeners })
    const meter = createBuildingMeter(map as never)
    meter(eastward(0, 200))
    expect(map.queries()).toBe(1)
    listeners.forEach((fire) => fire()) // a tile loaded
    meter(eastward(0, 200))
    expect(map.queries()).toBe(2)
  })
})

// Keeps the helpers' constants honest about what this file assumes.
describe('the test helpers this file leans on', () => {
  it('places offsets the way the meter measures them', () => {
    const p = offset(ORIGIN, 100, 100)
    expect((p[0] - ORIGIN[0]) * M_PER_DEG_LNG).toBeCloseTo(100, 6)
    expect((p[1] - ORIGIN[1]) * M_PER_DEG_LAT).toBeCloseTo(100, 6)
  })
})
