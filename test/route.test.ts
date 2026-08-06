import { describe, expect, it } from 'vitest'
import { doublesBack, generateLoop } from '../src/domain/route'
import { ORIGIN, offset, metresBetween, squareLoop } from './helpers'
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
  // Backtracking weighs heavier than missing the target length: a loop some
  // way long of target must still beat an exact one that rides the same road
  // twice — within reason, since past the tolerance the length floor takes
  // over and no amount of cleanliness excuses a walk half again as long.
  it('prefers a clean loop over an exact one that doubles back', async () => {
    const a = ORIGIN
    const b = offset(a, 0, 200)
    // Runs the a–b road in both directions (~16% of its length doubled),
    // but its reported length matches the 1 km target exactly.
    const doubled = [a, b, offset(b, 300, 0), offset(a, 300, 0), b, a]
    // No doubling, and 12% over target.
    const clean = [a, offset(a, 0, 300), offset(a, 300, 300), offset(a, 300, 0), a]

    let call = 0
    const route = await loopWith(async () =>
      call++ === 0 ? routeOf(doubled, 1000) : routeOf(clean, 1120),
    )

    expect(route.geometry.coordinates).toHaveLength(clean.length)
    expect(route.distanceKm).toBeCloseTo(1.12)
  })

  /**
   * The measured deadlock, pinned. A park has fewer paths than a street grid,
   * so the loop that actually goes through the park doubles back a little
   * more — and with every repeated metre priced alike, a 10% overlap cost more
   * than 100% greenness earned. Seven candidates would be generated and the
   * park one thrown away for the town one, every time, which is why "prefer
   * nature" kept producing streets.
   */
  it('lets a park loop double back a little rather than sending you to town', async () => {
    const a = ORIGIN
    const b = offset(a, 0, 200)
    // Through the park: repeats the a–b path (~16% doubled), all of it green.
    const park = [a, b, offset(b, 300, 0), offset(a, 300, 0), b, a]
    const parkRoute = () => ({
      ...routeOf(park, 1000),
      greenFraction: 0.9,
      greenMask: park.slice(1).map(() => true),
    })
    // Around the block: clean and exactly on target, but grey.
    const town = [a, offset(a, 0, 250), offset(a, 250, 250), offset(a, 250, 0), a]
    const townRoute = () => ({
      ...routeOf(town, 1000),
      greenFraction: 0.05,
      greenMask: town.slice(1).map(() => false),
    })

    let call = 0
    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      routeThrough: async () => (call++ === 0 ? parkRoute() : townRoute()),
    })

    expect(route.greenFraction).toBe(0.9)
  })

  // The discount is a discount, not forgiveness: between two park loops, the
  // one that does not walk the same path twice still wins. The doubled one
  // here is also past the overlap ceiling, so it must not stop the search
  // before the cleaner one has been seen at all.
  it('still prefers the green loop that does not double back', async () => {
    const a = ORIGIN
    const b = offset(a, 0, 200)
    const doubled = [a, b, offset(b, 300, 0), offset(a, 300, 0), b, a]
    const clean = [a, offset(a, 0, 250), offset(a, 250, 250), offset(a, 250, 0), a]
    const green = (coords: LngLat[], lengthM: number) => ({
      ...routeOf(coords, lengthM),
      greenFraction: 0.9,
      greenMask: coords.slice(1).map(() => true),
    })

    let call = 0
    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      routeThrough: async () => (call++ === 0 ? green(doubled, 1000) : green(clean, 1000)),
    })

    expect(route.geometry.coordinates).toHaveLength(clean.length)
  })

  /**
   * Measured on a 4 km ask: an 80%-green loop of 3.2 km beat greyer
   * full-length candidates — the length promise was being outbid by the very
   * greenness the app was tuned for. However green the walk, it is not the
   * walk that was asked for.
   */
  it('will not trade the promised length away for greenness', async () => {
    const a = ORIGIN
    const short = [a, offset(a, 0, 200), offset(a, 200, 200), offset(a, 200, 0), a]
    const full = [a, offset(a, 0, 250), offset(a, 250, 250), offset(a, 250, 0), a]
    const green = (coords: LngLat[], lengthM: number, fraction: number) => ({
      ...routeOf(coords, lengthM),
      greenFraction: fraction,
      greenMask: coords.slice(1).map(() => fraction > 0.5),
    })

    let call = 0
    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 4,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      routeThrough: async () =>
        call++ === 0 ? green(short, 3200, 0.8) : green(full, 4000, 0.2),
    })

    expect(route.distanceKm).toBeCloseTo(4)
  })

  // Inside the tolerance the trade still stands: a slightly-off green loop
  // beats an exact grey one, which is the choice the green weight exists for.
  it('still lets green win a rounding error in length', async () => {
    const a = ORIGIN
    const nearly = [a, offset(a, 0, 200), offset(a, 200, 200), offset(a, 200, 0), a]
    const exact = [a, offset(a, 0, 250), offset(a, 250, 250), offset(a, 250, 0), a]
    const dressed = (coords: LngLat[], lengthM: number, fraction: number) => ({
      ...routeOf(coords, lengthM),
      greenFraction: fraction,
      greenMask: coords.slice(1).map(() => fraction > 0.5),
    })

    let call = 0
    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 4,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      routeThrough: async () =>
        call++ === 0 ? dressed(nearly, 3750, 0.8) : dressed(exact, 4000, 0.1),
    })

    expect(route.greenFraction).toBe(0.8)
  })

  /**
   * Reported from Rotterdam: a loop threaded a shopping block along a mapped
   * passage that does not exist on the street. The router cannot know, but
   * the map's building footprints can — so a candidate that runs through a
   * building loses to any candidate that does not, even one further off the
   * target length.
   */
  it('keeps out of buildings when the map can tell it where they are', async () => {
    const a = ORIGIN
    // On target, but 100 m of it runs through a building.
    const through = [a, offset(a, 0, 250), offset(a, 250, 250), offset(a, 250, 0), a]
    // Clear of buildings, half a kilometre over.
    const around = [a, offset(a, 0, 400), offset(a, 400, 400), offset(a, 400, 0), a]

    let call = 0
    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      metresThroughBuildings: (coords) => (coords === through ? 100 : 0),
      routeThrough: async () =>
        call++ === 0 ? routeOf(through, 1000) : routeOf(around, 1500),
    })

    expect(route.distanceKm).toBeCloseTo(1.5)
  })

  // Footprints are tile geometry; a route hugging a facade grazes them
  // without being wrong. A few metres must not veto an otherwise good loop.
  it('forgives a graze along a facade', async () => {
    const a = ORIGIN
    const graze = [a, offset(a, 0, 250), offset(a, 250, 250), offset(a, 250, 0), a]
    const clear = [a, offset(a, 0, 400), offset(a, 400, 400), offset(a, 400, 0), a]

    let call = 0
    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      metresThroughBuildings: (coords) => (coords === graze ? 8 : 0),
      routeThrough: async () =>
        call++ === 0 ? routeOf(graze, 1000) : routeOf(clear, 1500),
    })

    // The grazing loop fits and is accepted; the detour is never even fetched.
    expect(route.distanceKm).toBeCloseTo(1)
  })

  // Without the router's land-cover estimate there is no mask, and repeated
  // ground must be priced at the full rate — "not measured" is not "woodland".
  it('gives no discount when the router never said what the ground was', async () => {
    const a = ORIGIN
    const b = offset(a, 0, 200)
    const doubled = [a, b, offset(b, 300, 0), offset(a, 300, 0), b, a]
    const clean = [a, offset(a, 0, 300), offset(a, 300, 300), offset(a, 300, 0), a]

    let call = 0
    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      // Doubled is exactly on target; clean is 12% over. With no mask the
      // doubling costs full price and clean must still win.
      routeThrough: async () => (call++ === 0 ? routeOf(doubled, 1000) : routeOf(clean, 1120)),
    })

    expect(route.geometry.coordinates).toHaveLength(clean.length)
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

  // A nature reserve with one access road is reached and left the same way.
  // The spur trimmer saw that as backtracking and cut it, so the loop rolled
  // past on the through-road a hundred-odd metres short of the pin. A stop
  // the rider asked for outranks the length target and the no-backtracking
  // rule both.
  it('keeps the leg that reaches a stop, even though it doubles back', async () => {
    const b = offset(ORIGIN, 0, 100)
    const tip = offset(b, 60, 0) // down a dead end
    const coords = [ORIGIN, b, tip, b, offset(b, 0, 100)]

    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      waypoints: [offset(tip, 6, 0)], // the pin, a few metres off the routed tip
      routeThrough: async () => routeOf(coords),
    })

    const closest = Math.min(
      ...route.geometry.coordinates.map((p) => metresBetween(p, tip)),
    )
    expect(closest).toBeLessThan(1)
    expect(route.geometry.coordinates).toHaveLength(coords.length)
  })

  // Without a pin on it, the very same dead end is still just backtracking.
  it('still trims a dead end that no stop asked for', async () => {
    const b = offset(ORIGIN, 0, 100)
    const tip = offset(b, 60, 0)
    const coords = [ORIGIN, b, tip, b, offset(b, 0, 100)]

    const route = await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      waypoints: [offset(ORIGIN, 0, 50)], // a stop on the way in, not at the tip
      routeThrough: async () => routeOf(coords),
    })

    expect(route.geometry.coordinates).toHaveLength(3)
  })
})

/**
 * A loop that goes out along a path and comes back down the same one draws
 * both legs on top of each other: one colour, and two sets of chevrons
 * pointing opposite ways along the same line. The map answers that by drawing
 * the two legs as lanes, one either side of the path — but only where there is
 * really a leg walked twice, because the whole route shifts to do it.
 */
describe('spotting a there-and-back leg', () => {
  it('leaves a loop that never repeats itself on the centreline', () => {
    expect(doublesBack(squareLoop(400).geometry.coordinates)).toBe(false)
  })

  it('sees the stick of a lollipop', () => {
    // 200 m out, once round a small block, and back down the same 200 m.
    const out: LngLat[] = []
    for (let m = 0; m <= 200; m += 20) out.push(offset(ORIGIN, 0, m))
    const top = out[out.length - 1]
    const block = squareLoop(120, 20).geometry.coordinates.map((c) => [
      c[0] + (top[0] - ORIGIN[0]),
      c[1] + (top[1] - ORIGIN[1]),
    ]) as LngLat[]

    expect(doublesBack([...out, ...block, ...out.slice().reverse()])).toBe(true)
  })

  // Four junctions clipped in passing add up to a hundred metres and are not a
  // there-and-back leg. The longest single run is what decides it.
  it('is not fooled by a loop that clips its own path here and there', () => {
    const coords = squareLoop(400).geometry.coordinates.slice()
    for (const at of [10, 25, 40, 55]) coords.push(coords[at], coords[at + 1])

    expect(doublesBack(coords)).toBe(false)
  })
})
