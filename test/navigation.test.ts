import { describe, expect, it } from 'vitest'
import {
  prepareRoute,
  positionAtKm,
  bearingAlong,
  segmentBearingAt,
  locateInitial,
  locateOnRoute,
  nextManeuver,
  maneuverAfter,
  trimToRoute,
} from '../src/domain/navigation'
import { ORIGIN, offset, metresBetween, routeFrom, squareLoop } from './helpers'
import type { LngLat } from '../src/domain/geo'

const northThenEast = () =>
  prepareRoute(routeFrom([{ north: 200 }, { east: 200 }]))

describe('positionAtKm', () => {
  it('interpolates within a segment', () => {
    const p = prepareRoute(routeFrom([{ north: 100 }]))
    const half = positionAtKm(p, p.totalKm / 2)
    expect(metresBetween(half.position, offset(ORIGIN, 0, 50))).toBeLessThan(1)
  })

  it('clamps past either end instead of running off the line', () => {
    const p = prepareRoute(routeFrom([{ north: 100 }]))
    expect(metresBetween(positionAtKm(p, -5).position, ORIGIN)).toBeLessThan(1)
    const end = p.coords[p.coords.length - 1]
    expect(metresBetween(positionAtKm(p, 99).position, end)).toBeLessThan(1)
  })
})

describe('direction of travel', () => {
  it('reads the bearing of the leg being ridden', () => {
    const p = northThenEast()
    expect(segmentBearingAt(p, 0)).toBeCloseTo(0, 0) // due north
  })

  // The bug behind "the arrow points where the camera looks": a heading
  // averaged over a window straddles both legs of a corner, so it matches
  // neither. The segment bearing has to stay on the leg you are on.
  it('does not average across a corner the way the look-ahead does', () => {
    const p = northThenEast()
    const cornerKm = p.cumulative[1] // exactly at the bend
    const justBefore = cornerKm - 0.01

    const segment = segmentBearingAt(p, 0, positionAtKm(p, justBefore).position)
    const averaged = bearingAlong(p, justBefore)

    expect(segment).toBeCloseTo(0, 0) // still heading north
    expect(Math.abs(averaged - segment)).toBeGreaterThan(20) // window sees the turn
  })

  it('turns onto the new leg once past the corner', () => {
    const p = northThenEast()
    const after = positionAtKm(p, p.cumulative[1] + 0.02)
    expect(segmentBearingAt(p, 1, after.position)).toBeCloseTo(90, 0) // due east
  })
})

describe('locating on the route', () => {
  // A loop's finish sits on its start. Snapping to the nearest point can
  // just as easily pick the end, which read as "you have already arrived".
  it('places you at the start of a loop, not its end', () => {
    const p = prepareRoute(squareLoop())
    const fix = locateInitial(p, ORIGIN)
    expect(fix.alongKm).toBe(0)
    expect(fix.index).toBe(0)
  })

  it('still locates you correctly mid-loop on the first fix', () => {
    const p = prepareRoute(squareLoop())
    const target = p.totalKm * 0.5
    const fix = locateInitial(p, positionAtKm(p, target).position)

    // Candidates within TIE_M of the best resolve to the earliest, so the
    // answer may sit up to 20 m back down the road — that is the rule doing
    // its job. What must not happen is being dragged to the start, or
    // snapped to the finish that sits on top of it.
    expect(fix.alongKm).toBeGreaterThan(target - 0.025)
    expect(fix.alongKm).toBeLessThanOrEqual(target + 0.005)
  })

  it('reports how far off the line you are', () => {
    const p = northThenEast()
    const aside = offset(ORIGIN, 60, 50)
    expect(locateOnRoute(p, aside, 0).offRouteM).toBeGreaterThan(50)
  })

  // Searching only a window ahead keeps a loop from teleporting progress, but
  // it must still recover when that window clearly holds nothing near you.
  it('falls back to a full search when the window is plainly wrong', () => {
    const p = prepareRoute(squareLoop())
    const elsewhere = positionAtKm(p, p.totalKm * 0.4).position
    const fix = locateOnRoute(p, elsewhere, 0)
    expect(fix.alongKm).toBeCloseTo(p.totalKm * 0.4, 2)
    expect(fix.offRouteM).toBeLessThan(1)
  })

  // Deliberate limitation, worth pinning down: where a loop runs back beside
  // itself, a nearby leg is a believable match and the window keeps the
  // rider on the lap they were already on. Rejecting the impossible jump is
  // the tracker's job, not the projection's.
  it('prefers the current lap when two legs pass close together', () => {
    const p = prepareRoute(squareLoop())
    const nearStart = positionAtKm(p, 0.05).position
    const fix = locateOnRoute(p, nearStart, p.coords.length - 5)
    expect(fix.alongKm).toBeGreaterThan(p.totalKm * 0.9)
  })
})

describe('maneuvers', () => {
  const withHints = (hints: number[][]) =>
    prepareRoute(
      routeFrom([{ north: 100 }, { north: 100 }, { north: 100 }, { north: 100 }], {
        voicehints: hints,
      }),
    )

  it('drops "continue" and off-route hints', () => {
    // [pointIndex, command, exit, distance, angle]; 1 = continue, 12 = off route
    const p = withHints([[1, 1, 0, 0, 0], [2, 12, 0, 0, 0]])
    expect(p.maneuvers).toHaveLength(0)
  })

  it('drops a slight turn that is really just a curve', () => {
    const gentle = withHints([[2, 6, 0, 0, 8]]) // 8° "slight right"
    const real = withHints([[2, 6, 0, 0, 35]])
    expect(gentle.maneuvers).toHaveLength(0)
    expect(real.maneuvers).toHaveLength(1)
  })

  it('merges turns that are metres apart into one', () => {
    const p = prepareRoute(
      routeFrom([{ north: 10 }, { north: 10 }, { north: 300 }], {
        voicehints: [[1, 2, 0, 0, 90], [2, 5, 0, 0, 90]],
      }),
    )
    expect(p.maneuvers).toHaveLength(1)
  })

  it('never reports a negative distance to the next turn', () => {
    const p = withHints([[2, 2, 0, 0, 90]])
    const justPast = p.maneuvers[0].atKm + 0.002
    expect(nextManeuver(p, justPast)?.distanceM ?? 0).toBeGreaterThanOrEqual(0)
  })

  // A walker reads the screen at the fork and puts the phone away, so a turn
  // that lands right behind the next one has to travel with it.
  it('reports the turn after the next one, and the gap to it', () => {
    const p = withHints([[1, 2, 0, 0, 90], [3, 5, 0, 0, 90]])
    const first = nextManeuver(p, 0)!
    const second = maneuverAfter(p, first.atKm)!

    expect(second.kind).toBe('right')
    expect(second.gapM).toBeCloseTo((p.maneuvers[1].atKm - first.atKm) * 1000, 3)
  })

  it('has nothing to add after the last turn', () => {
    const p = withHints([[2, 2, 0, 0, 90]])
    expect(maneuverAfter(p, p.maneuvers[0].atKm)).toBeNull()
  })
})

/**
 * The way back is routed to a point some way ahead along the loop, so it often
 * rejoins earlier and then rides the loop to get there — drawing an orange
 * dashed line along the very route it is leading you back to.
 */
describe('trimming the way back', () => {
  // A straight run north, so "on the route" is easy to reason about.
  const straight = () => prepareRoute(routeFrom([{ north: 400 }]))

  it('ends where it first reaches the route', () => {
    const p = straight()
    // Out to one side, back to the line, then a long run along it.
    const path: LngLat[] = [
      offset(ORIGIN, 60, 100),
      offset(ORIGIN, 30, 110),
      offset(ORIGIN, 0, 120), // on the line
      offset(ORIGIN, 0, 200), // and onward along it — not ours to draw
      offset(ORIGIN, 0, 300),
    ]
    const trimmed = trimToRoute(p, path, 0, 12)

    expect(trimmed.coordinates).toHaveLength(3)
    expect(metresBetween(trimmed.coordinates[2], offset(ORIGIN, 0, 120))).toBeLessThan(1)
  })

  it('reports the distance of what is left, not of the whole path', () => {
    const p = straight()
    const path: LngLat[] = [
      offset(ORIGIN, 60, 100),
      offset(ORIGIN, 0, 100), // 60 m across, then on the line
      offset(ORIGIN, 0, 300), // a further 200 m that gets cut
    ]
    const trimmed = trimToRoute(p, path, 0, 12)
    expect(trimmed.distanceKm * 1000).toBeCloseTo(60, 0)
  })

  it('leaves a path that never reaches the route alone', () => {
    const p = straight()
    const path: LngLat[] = [
      offset(ORIGIN, 200, 100),
      offset(ORIGIN, 180, 150),
      offset(ORIGIN, 160, 200),
    ]
    const trimmed = trimToRoute(p, path, 0, 12)
    expect(trimmed.coordinates).toHaveLength(3)
  })
})

/**
 * On a path walked in both directions — an out-and-back, or the stick of a
 * lollipop — standing anywhere puts you at two places along the route at once:
 * a hundred metres out and, on the same paving stone, six hundred metres on
 * the way home. Both fit the reading perfectly, so which came out nearest was
 * settled by whether the router laid its vertices in quite the same spots on
 * the way back. It does not, and losing that toss meant being told you were
 * heading home before you had reached the turnaround.
 */
describe('which leg of a there-and-back you are on', () => {
  // Out 400 m and back, the return leg sampled a little differently — which
  // is what BRouter actually hands back.
  const outAndBack = () => {
    const up: LngLat[] = []
    for (let m = 0; m <= 400; m += 20) up.push(offset(ORIGIN, 0, m))
    const down: LngLat[] = []
    for (let m = 390; m >= 0; m -= 20) down.push(offset(ORIGIN, 0.3, m))
    return prepareRoute({
      geometry: { type: 'LineString', coordinates: [...up, ...down] },
      distanceKm: 0.8,
      durationSec: 0,
      voicehints: [],
    })
  }

  it('keeps you on the way out until you have turned round', () => {
    const p = outAndBack()
    const at350 = offset(ORIGIN, 0.2, 350)
    const believedAt = (km: number) =>
      p.cumulative.findIndex((c) => c >= km)

    const fix = locateOnRoute(p, at350, believedAt(0.33))

    expect(fix.alongKm).toBeLessThan(p.totalKm / 2)
    expect(fix.alongKm).toBeCloseTo(0.35, 1)
  })

  it('and on the way home once you have', () => {
    const p = outAndBack()
    const at350 = offset(ORIGIN, 0.2, 350)

    // Same paving stone, but we were last seen past the turnaround.
    const fix = locateOnRoute(p, at350, p.cumulative.findIndex((c) => c >= 0.43))

    expect(fix.alongKm).toBeGreaterThan(p.totalKm / 2)
  })

  // The tie-break is only allowed to choose between readings that are somewhere
  // else entirely. A candidate a few metres up the same stretch is not a second
  // opinion about which leg you are on, and letting it win would drag the
  // projection back down the road for nothing.
  it('does not drag the projection backwards along the leg it picked', () => {
    const p = outAndBack()
    const beside = offset(ORIGIN, 7, 200)

    const fix = locateOnRoute(p, beside, p.cumulative.findIndex((c) => c >= 0.19))

    expect(fix.alongKm).toBeCloseTo(0.2, 2)
    expect(fix.offRouteM).toBeLessThan(8)
  })
})
