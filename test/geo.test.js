import { describe, expect, it } from 'vitest'
import { loopViaWithWaypoints, bearingBetween } from '../src/lib/geo.js'
import { ORIGIN, offset } from './helpers.js'

describe('loopViaWithWaypoints', () => {
  const east = offset(ORIGIN, 2000, 0)
  const north = offset(ORIGIN, 0, 2000)
  const centroid = [
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
