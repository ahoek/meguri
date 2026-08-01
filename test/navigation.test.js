import { describe, expect, it } from 'vitest'
import {
  prepareRoute,
  positionAtKm,
  bearingAlong,
  segmentBearingAt,
  locateInitial,
  locateOnRoute,
  nextManeuver,
} from '../src/lib/navigation.js'
import { ORIGIN, offset, metresBetween, routeFrom, squareLoop } from './helpers.js'

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
    expect(fix.alongKm).toBeCloseTo(target, 2)
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
  const withHints = (hints) =>
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
})
