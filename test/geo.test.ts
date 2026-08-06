import { describe, expect, it } from 'vitest'
import { loopViaPoints, loopViaWithWaypoints, bearingBetween, distanceKm } from '../src/domain/geo'
import { ORIGIN, offset } from './helpers'
import type { LngLat } from '../src/domain/geo'

describe('loopViaWithWaypoints', () => {
  const east = offset(ORIGIN, 2000, 0)
  const north = offset(ORIGIN, 0, 2000)
  const centroid: [number, number] = [
    (ORIGIN[0] + east[0] + north[0]) / 3,
    (ORIGIN[1] + east[1] + north[1]) / 3,
  ]

  it('keeps every waypoint in the via list, untouched', () => {
    const via = loopViaWithWaypoints(ORIGIN, [east, north], 0.5, 0, true, 4)
    expect(via).toEqual(expect.arrayContaining([east, north]))
    expect(via.length).toBeGreaterThan(2) // filler points joined them
  })

  it('orders all points by angle around the centroid, so the loop goes round', () => {
    const via = loopViaWithWaypoints(ORIGIN, [north, east], 0.5, 0, true, 4)
    const startAngle = bearingBetween(centroid, ORIGIN)
    const angles = via.map(
      (p) => (((bearingBetween(centroid, p) - startAngle) % 360) + 360) % 360,
    )
    for (let i = 1; i < angles.length; i++) {
      expect(angles[i]).toBeGreaterThan(angles[i - 1])
    }
  })

  it('walks the other way round when counter-clockwise', () => {
    const cw = loopViaWithWaypoints(ORIGIN, [east, north], 0.5, 0, true, 0)
    const ccw = loopViaWithWaypoints(ORIGIN, [east, north], 0.5, 0, false, 0)
    // Clockwise from the start (south-west of the centroid) the north point
    // comes first; counter-clockwise it's the east one.
    expect(cw).toEqual([north, east])
    expect(ccw).toEqual([east, north])
  })
})

/**
 * The loop's via points sit on an ellipse whose perimeter is the promised
 * length. Unstretched it is the circle it always was; stretched, the same
 * walking length reaches further along the bearing and narrows across it —
 * which is how a loop gets to a wood the circle could never touch.
 */
describe('stretching the loop toward the green', () => {
  const reachKm = (points: LngLat[]) =>
    Math.max(...points.map((p) => distanceKm(ORIGIN, p)))

  it('is exactly the old circle when unstretched', () => {
    const round = loopViaPoints(ORIGIN, 1, 45, true, 4)
    const declared = loopViaPoints(ORIGIN, 1, 45, true, 4, 1)

    expect(declared).toEqual(round)
    // Every via point one radius from the centre — a circle.
    for (const p of round) {
      expect(reachKm([p])).toBeLessThanOrEqual(2.001)
    }
  })

  it('reaches further along the bearing for the same length', () => {
    const round = loopViaPoints(ORIGIN, 1, 0, true, 5)
    const stretched = loopViaPoints(ORIGIN, 1, 0, true, 5, 1.6)

    // A circle of radius r never reaches past 2r; the ellipse does.
    expect(reachKm(round)).toBeLessThanOrEqual(2.001)
    expect(reachKm(stretched)).toBeGreaterThan(2.4)
  })

  it('pays for the reach with width, keeping the length honest', () => {
    // The polygon through the via points approximates the perimeter; the
    // radius fitting absorbs the few percent the approximation is off by.
    const perimeter = (points: LngLat[]) => {
      const ring = [ORIGIN, ...points, ORIGIN]
      let total = 0
      for (let i = 1; i < ring.length; i++) total += distanceKm(ring[i - 1], ring[i])
      return total
    }
    const round = perimeter(loopViaPoints(ORIGIN, 1, 0, true, 8))
    const stretched = perimeter(loopViaPoints(ORIGIN, 1, 0, true, 8, 1.6))

    expect(Math.abs(stretched - round) / round).toBeLessThan(0.08)
  })
})
