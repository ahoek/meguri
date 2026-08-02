import { describe, expect, it } from 'vitest'
import { generateLoop } from '../src/domain/route'
import { ORIGIN, offset, metresBetween } from './helpers'
import type { LngLat } from '../src/domain/geo'
import type { Route, RouteThrough, VoiceHint } from '../src/domain/route'

// The domain takes the router as a plain function, so tests hand it stubs —
// no network, no fetch mocking.
function routeOf(coordinates: LngLat[], lengthM = 1000, voicehints: VoiceHint[] = []): Route {
  return {
    geometry: { type: 'LineString', coordinates },
    distanceKm: lengthM / 1000,
    durationSec: 300,
    voicehints,
  }
}

function loopWith(routeThrough: RouteThrough) {
  return generateLoop({
    start: ORIGIN,
    targetKm: 1,
    bearing: 0,
    clockwise: true,
    routeThrough,
  })
}

describe('trimming out-and-back spurs', () => {
  // A dead-end tip doubles back on itself: A → T → A. Riding it means
  // covering the same road twice, so it comes out of the line.
  const withSpur = () => {
    const a = ORIGIN
    const b = offset(a, 0, 100)
    const tip = offset(b, 60, 0)
    const c = offset(b, 0, 100)
    return { coords: [a, b, tip, b, c], b }
  }

  it('removes the doubled-back tip', async () => {
    const { coords, b } = withSpur()
    const route = await loopWith(async () => routeOf(coords))
    const out = route.geometry.coordinates

    expect(out).toHaveLength(3)
    expect(metresBetween(out[1], b)).toBeLessThan(1)
  })

  // Turn instructions index into the untrimmed point list, so they have to be
  // re-indexed or they point at the wrong places for the rest of the ride.
  it('re-indexes the turn instructions it keeps', async () => {
    const { coords } = withSpur()
    // A turn at point 4 (the final point) survives; one at the spur tip does not.
    const route = await loopWith(async () =>
      routeOf(coords, 1000, [
        [2, 2, 0, 0, 90], // on the tip — goes away with it
        [4, 5, 0, 0, 90], // on the last point — kept, but now at index 2
      ]),
    )

    expect(route.voicehints).toHaveLength(1)
    expect(route.voicehints[0][0]).toBe(2)
    expect(route.voicehints[0][1]).toBe(5)
  })

  it('leaves a clean route untouched', async () => {
    const straight = [ORIGIN, offset(ORIGIN, 0, 100), offset(ORIGIN, 0, 200)]
    const route = await loopWith(async () => routeOf(straight, 1000, [[1, 2, 0, 0, 90]]))

    expect(route.geometry.coordinates).toHaveLength(3)
    expect(route.voicehints[0][0]).toBe(1)
  })
})

describe('scoring loop candidates', () => {
  // Backtracking weighs heavier than missing the target length: a loop half
  // a kilometre long-of-target must still beat an exact one that rides the
  // same road twice.
  it('prefers a clean loop over an exact one that doubles back', async () => {
    const a = ORIGIN
    const b = offset(a, 0, 200)
    // Runs the a–b road in both directions (~16% of its length doubled),
    // but its reported length matches the 1 km target exactly.
    const doubled = [a, b, offset(b, 300, 0), offset(a, 300, 0), b, a]
    // No doubling, but half a kilometre over target.
    const clean = [a, offset(a, 0, 300), offset(a, 300, 300), offset(a, 300, 0), a]

    let call = 0
    const route = await loopWith(async () =>
      call++ === 0 ? routeOf(doubled, 1000) : routeOf(clean, 1500),
    )

    expect(route.geometry.coordinates).toHaveLength(clean.length)
    expect(route.distanceKm).toBeCloseTo(1.5)
  })
})

describe('waypoints', () => {
  it('routes the loop through every user waypoint', async () => {
    const wp = offset(ORIGIN, 500, 500)
    const requested: LngLat[][] = []
    const clean = [
      ORIGIN,
      offset(ORIGIN, 0, 300),
      offset(ORIGIN, 300, 300),
      offset(ORIGIN, 300, 0),
      ORIGIN,
    ]

    await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      waypoints: [wp],
      routeThrough: async (points) => {
        requested.push(points)
        return routeOf(clean)
      },
    })

    expect(requested[0]).toContainEqual(wp)
  })
})
