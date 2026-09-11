import { describe, expect, it } from 'vitest'
import { doublesBack, generateLoop, generateNodeLoop } from '../src/domain/route'
import { buildNetwork } from '../src/domain/knooppunten'
import { ORIGIN, offset, metresBetween, squareLoop, M_PER_DEG_LAT, M_PER_DEG_LNG } from './helpers'
import type { LngLat } from '../src/domain/geo'
import type { Route, RouteThrough, VoiceHint } from '../src/domain/route'
import type { NetworkLeg, NetworkNode } from '../src/domain/knooppunten'

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
   * "I don't mind a shorter or longer route if it's nicer" — with nature on,
   * length and greenness trade openly inside a widened tolerance, so a walk
   * fifteen percent short but four times as green wins.
   */
  it('lets a clearly nicer walk run somewhat short when nature is on', async () => {
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
        call++ === 0 ? green(short, 3400, 0.8) : green(full, 4000, 0.2),
    })

    expect(route.greenFraction).toBe(0.8)
  })

  // "Somewhat shorter" was the offer. Half the walk missing is not, and no
  // greenness pays for it.
  it('will not accept a fraction of the promised walk however green', async () => {
    const a = ORIGIN
    const stub = [a, offset(a, 0, 150), offset(a, 150, 150), offset(a, 150, 0), a]
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
        call++ === 0 ? green(stub, 2400, 0.9) : green(full, 4000, 0.15),
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
describe('reaching for green beyond the circle', () => {
  /**
   * From a street grid, grey loops fit on the first attempt in any direction,
   * and a wood 1.5 km away is beyond a 4 km circle's reach in every one of
   * them. The sweep answers "which direction"; only the stretch can answer
   * "further than the circle can go" — so the search must not settle for a
   * fitting grey loop until the stretched attempts have had their turn.
   */
  it('stretches along the greenest bearing once the sweep is spent', async () => {
    const a = ORIGIN
    const asked: LngLat[][] = []
    const greyFit = () => ({
      ...routeOf(
        [a, offset(a, 0, 250), offset(a, 250, 250), offset(a, 250, 0), a],
        1000,
      ),
      greenFraction: 0.1,
      greenMask: [false, false, false, false],
    })

    await generateLoop({
      start: ORIGIN,
      targetKm: 1,
      bearing: 0,
      clockwise: true,
      preferGreen: true,
      routeThrough: async (points) => {
        asked.push(points)
        return greyFit()
      },
    })

    // Reach of each request: how far its furthest via point sits from home.
    const reaches = asked.map((points) =>
      Math.max(...points.map((p) => metresBetween(p, a))),
    )
    // targetKm 1 → radius ~159 m → a circle never asks past ~320 m.
    expect(Math.min(...reaches)).toBeLessThan(340)
    // The late attempts do: the ellipse reaches for the green.
    expect(Math.max(...reaches)).toBeGreaterThan(420)
  })
})

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

  /**
   * The stick a loop hangs off is often barely longer than the street it
   * leaves by. This one is a single 35 m segment walked out and back — under
   * the fifty-metre floor this used to carry, so the whole loop was drawn as
   * one line with both directions' chevrons interleaved along it, which is
   * the confusion lanes are for. It is also the first and last thing anyone
   * walking the loop sees.
   */
  const lollipop = (stickM: number) => {
    const tip = offset(ORIGIN, 0, stickM)
    const block = squareLoop(120, 20).geometry.coordinates.map((c) => [
      c[0] + (tip[0] - ORIGIN[0]),
      c[1] + (tip[1] - ORIGIN[1]),
    ]) as LngLat[]
    return [ORIGIN, ...block, ORIGIN] as LngLat[]
  }

  it('sees a stick shorter than a block of the loop it hangs off', () => {
    expect(doublesBack(lollipop(35))).toBe(true)
  })

  // And still holds a floor under it: twenty metres of shared tarmac is a
  // junction touching itself, where a metre of offset buys nothing.
  it('leaves a stick too short to read as a leg of its own', () => {
    expect(doublesBack(lollipop(20))).toBe(false)
  })

  // Four junctions clipped in passing add up to a hundred metres and are not a
  // there-and-back leg. The longest single run is what decides it.
  it('is not fooled by a loop that clips its own path here and there', () => {
    const coords = squareLoop(400).geometry.coordinates.slice()
    for (const at of [10, 25, 40, 55]) coords.push(coords[at], coords[at + 1])

    expect(doublesBack(coords)).toBe(false)
  })
})

describe('a ride along the junction network', () => {
  // Four junctions on a square plus a diagonal, each leg a straight line of
  // its own ways. Real legs bend; here the leg's line and the straight line
  // coincide, so "on the leg" can be checked against the segment between
  // its junctions.
  const A = offset(ORIGIN, 500, 0)
  const B = offset(A, 3000, 0)
  const C = offset(A, 3000, 3000)
  const D = offset(A, 0, 3000)
  const nodes: NetworkNode[] = [
    { ref: '1', lngLat: A },
    { ref: '2', lngLat: B },
    { ref: '3', lngLat: C },
    { ref: '4', lngLat: D },
  ]
  const legs: NetworkLeg[] = [
    { a: '1', b: '2', id: 12, km: 3 },
    { a: '2', b: '3', id: 23, km: 3 },
    { a: '3', b: '4', id: 34, km: 3 },
    { a: '4', b: '1', id: 41, km: 3 },
    { a: '1', b: '3', id: 13, km: 4.3 },
  ]
  const ends: Record<number, [LngLat, LngLat]> = {
    12: [A, B],
    23: [B, C],
    34: [C, D],
    41: [D, A],
    13: [A, C],
  }
  const legBetween = (a: string, b: string) =>
    legs.find((l) => [l.a, l.b].sort().join() === [a, b].sort().join())!

  // Each leg as OSM would hand it back: three ways, shuffled and one reversed.
  const geometryOf = (ids: number[]) =>
    new Map(
      ids.map((id) => {
        const [p, q] = ends[id]
        const at = (f: number): LngLat => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]
        return [
          id,
          [
            { role: '', points: [at(0.7), at(1)] },
            { role: '', points: [at(0.3), at(0)] },
            { role: '', points: [at(0.3), at(0.7)] },
          ],
        ]
      }),
    )

  const seeded = (s = 7) => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

  const distanceToSegment = (p: LngLat, [a, b]: [LngLat, LngLat]) => {
    const ax = a[0] * M_PER_DEG_LNG
    const ay = a[1] * M_PER_DEG_LAT
    const bx = b[0] * M_PER_DEG_LNG
    const by = b[1] * M_PER_DEG_LAT
    const px = p[0] * M_PER_DEG_LNG
    const py = p[1] * M_PER_DEG_LAT
    const t = Math.max(
      0,
      Math.min(1, ((px - ax) * (bx - ax) + (py - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2)),
    )
    return Math.hypot(px - (ax + t * (bx - ax)), py - (ay + t * (by - ay)))
  }

  async function ride({
    legGeometry = async (ids: number[]) => geometryOf(ids),
    seed = 7,
  } = {}) {
    const asked: LngLat[][] = []
    const found = await generateNodeLoop({
      start: ORIGIN,
      targetKm: 13,
      network: buildNetwork(nodes, legs),
      routeThrough: async (points) => {
        asked.push(points)
        return routeOf(points, 500, [[1, 5, 0, 0, 90]]) // a turn where it lands
      },
      legGeometry,
      random: seeded(seed),
    })
    return { found, asked }
  }

  // The legs are ridden as OpenStreetMap draws them: every vertex of every
  // leg, in riding order, one leg after the next — so the ride follows the
  // signed paths and skips none of the junctions. The router is only asked
  // for the two ends.
  it('rides each leg exactly as drawn, between two routed connectors', async () => {
    const { found, asked } = await ride()
    expect(found).not.toBeNull()
    const { plan, route } = found!
    expect(plan[0]).toBe(plan[plan.length - 1])
    expect(plan.length).toBeGreaterThanOrEqual(4)

    expect(asked).toHaveLength(2)
    expect(asked[0][0]).toEqual(ORIGIN) // doorstep to the first junction…
    expect(asked[1][1]).toEqual(ORIGIN) // …and the last junction home

    const coords = route.geometry.coordinates
    // From the cursor on: the ride begins and ends at the same junction.
    let cursor = 0
    const indexOf = (p: LngLat) =>
      coords.findIndex((c, i) => i >= cursor && metresBetween(c, p) < 0.5)
    for (let i = 0; i < plan.length - 1; i++) {
      const [p, q] = ends[legBetween(plan[i], plan[i + 1]).id]
      const at = (f: number): LngLat => [p[0] + (q[0] - p[0]) * f, p[1] + (q[1] - p[1]) * f]
      const found = [0, 0.3, 0.7, 1].map(at).map(indexOf).sort((a, b) => a - b)
      expect(found[0]).toBeGreaterThanOrEqual(cursor)
      // Contiguous: nothing of the router's between the leg's own vertices.
      expect(found[3] - found[0]).toBe(3)
      cursor = found[3]
    }
    // The connector home follows the last leg.
    expect(cursor).toBeLessThan(coords.length - 1)
  })

  it('costs the ride by the legs’ own length plus the connectors', async () => {
    const { found } = await ride()
    const { plan, route } = found!
    let legsKm = 0
    for (let i = 0; i < plan.length - 1; i++) legsKm += legBetween(plan[i], plan[i + 1]).km
    expect(route.distanceKm).toBeCloseTo(legsKm + 1, 0)
    expect(route.durationSec).toBeGreaterThan(0)
  })

  // The square's corners are 90° turns, and nothing else would say so: no
  // router looks at the legs.
  it('reads the turns at the corners off the legs themselves', async () => {
    const { found } = await ride()
    const { route } = found!
    const corners = route.voicehints.filter((h) => h[1] === 2 || h[1] === 5)
    expect(corners.length).toBeGreaterThanOrEqual(2)
    // Connector hints are re-indexed into the assembled line, in order. A
    // leg's own corner hint may share a vertex with the connector's first.
    for (let i = 1; i < route.voicehints.length; i++) {
      expect(route.voicehints[i][0]).toBeGreaterThanOrEqual(route.voicehints[i - 1][0])
    }
  })

  it('hands back the numbers, placed along the finished line', async () => {
    const { found } = await ride()
    const stops = found!.route.junctions!
    expect(stops.map((s) => s.ref)).toEqual(found!.plan)
    for (let i = 1; i < stops.length; i++) expect(stops[i].atKm).toBeGreaterThan(stops[i - 1].atKm)
  })

  // Tags lie about length; geometry does not. A plan made on legs tagged
  // far longer than they are gets redone once the legs have been seen.
  it('re-plans when the fetched legs prove the tagged lengths wrong', async () => {
    // The square's legs are really 3 km and the diagonal 4.2; tagged 3.6
    // and 5, two sides and the diagonal look like the 13 km asked for.
    const lying = legs.map((l) => ({ ...l, km: l.id === 13 ? 5 : 3.6 }))
    let asks = 0
    const found = await generateNodeLoop({
      start: ORIGIN,
      targetKm: 13,
      network: buildNetwork(nodes, lying),
      routeThrough: async (points) => routeOf(points, 500),
      legGeometry: async (ids) => {
        asks++
        return geometryOf(ids)
      },
      random: seeded(3),
    })
    expect(found).not.toBeNull()
    // Four real legs of 3 km, not three tagged ones: the length asked for.
    expect(found!.route.distanceKm).toBeCloseTo(13, 0)
    expect(asks).toBeGreaterThan(1)
  })

  // Data is data: a leg whose ways do not reach its junctions is struck and
  // the ride planned again without it, rather than routed as a guess.
  it('strikes a leg whose geometry is unusable and plans without it', async () => {
    let asks = 0
    const brokenLeg23 = async (ids: number[]) => {
      asks++
      const map = geometryOf(ids)
      if (map.has(23)) {
        map.set(23, [{ role: '', points: [offset(ORIGIN, 9000, 9000), offset(ORIGIN, 9500, 9000)] }])
      }
      return map
    }
    let struck = 0
    for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
      asks = 0
      const { found } = await ride({ legGeometry: brokenLeg23, seed })
      expect(found).not.toBeNull()
      const plan = found!.plan
      for (let i = 0; i < plan.length - 1; i++) {
        expect(legBetween(plan[i], plan[i + 1]).id).not.toBe(23)
      }
      if (asks > 1) struck++
    }
    // Some of those first plans wanted leg 23 and had to be redone.
    expect(struck).toBeGreaterThan(0)
  })
})
