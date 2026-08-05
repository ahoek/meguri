import { describe, expect, it } from 'vitest'
import { capTurnarounds, roundCorners } from '../src/map/route-layers'
import { ORIGIN, offset, metresBetween } from './helpers'
import type { LngLat } from '../src/domain/geo'

/**
 * Where the route is drawn as two lanes, the line is shifted sideways — and an
 * offset line cannot turn a hard corner: the two segments fold through each
 * other on the inside of the bend and leave a hook hanging off it. So the hard
 * corners go, replaced by a curve short enough to be the corner a real street
 * already has.
 */
describe('rounding a corner so an offset line can follow it', () => {
  /** East 100 m, then north 100 m: a right angle. */
  const rightAngle = (): LngLat[] => [
    ORIGIN,
    offset(ORIGIN, 100, 0),
    offset(ORIGIN, 100, 100),
  ]

  it('curves through a right angle instead of turning it', () => {
    const rounded = roundCorners(rightAngle())

    expect(rounded.length).toBeGreaterThan(3)
    // Nowhere near the corner is the old vertex still repeated verbatim.
    expect(rounded.filter((p) => metresBetween(p, offset(ORIGIN, 100, 0)) < 0.01))
      .toHaveLength(0)
  })

  it('keeps the curve inside the width of a street corner', () => {
    const corner = offset(ORIGIN, 100, 0)

    for (const p of roundCorners(rightAngle())) {
      expect(metresBetween(p, corner)).toBeGreaterThan(-1)
    }
    // The curve leaves the corner by at most the back-off it was given.
    const nearest = roundCorners(rightAngle())
      .map((p) => metresBetween(p, corner))
      .sort((a, b) => a - b)[0]
    expect(nearest).toBeLessThan(3.1)
  })

  it('never moves where the route starts or ends', () => {
    const rounded = roundCorners(rightAngle())

    expect(metresBetween(rounded[0], ORIGIN)).toBeLessThan(0.01)
    expect(metresBetween(rounded[rounded.length - 1], offset(ORIGIN, 100, 100)))
      .toBeLessThan(0.01)
  })

  it('leaves a gentle bend alone — there is no fold to smooth', () => {
    const gentle: LngLat[] = [ORIGIN, offset(ORIGIN, 100, 0), offset(ORIGIN, 200, 20)]

    expect(roundCorners(gentle)).toEqual(gentle)
  })

  // A corner mapped with vertices a metre apart must not be smoothed with a
  // three-metre curve: the curve would swallow the bend it came to fix.
  it('takes no more than half of the segments it has to work with', () => {
    const tight: LngLat[] = [
      ORIGIN,
      offset(ORIGIN, 2, 0),
      offset(ORIGIN, 2, 2),
      offset(ORIGIN, 2, 40),
    ]
    const rounded = roundCorners(tight)

    for (const p of rounded) {
      expect(metresBetween(p, ORIGIN)).toBeLessThan(41)
    }
    expect(rounded.length).toBeGreaterThan(tight.length)
  })

  it('has nothing to do to a line with no corners in it', () => {
    const straight: LngLat[] = [ORIGIN, offset(ORIGIN, 50, 0), offset(ORIGIN, 100, 0)]

    expect(roundCorners(straight)).toEqual(straight)
  })
})

/**
 * An out-and-back reverses at a single vertex, and an offset line cannot draw
 * that: the lane swaps sides in no distance at all, so both sides get capped
 * and the tip becomes two rounded stubs side by side. Giving the turn some
 * room lets the two lanes meet in a loop instead.
 */
describe('giving a turnaround room to turn in', () => {
  /** North 100 m and straight back down again. */
  const thereAndBack = (): LngLat[] => {
    const up: LngLat[] = []
    for (let m = 0; m <= 100; m += 20) up.push(offset(ORIGIN, 0, m))
    return [...up, ...up.slice(0, -1).reverse()]
  }

  it('opens out the tip that used to be a single vertex', () => {
    const capped = capTurnarounds(thereAndBack())

    expect(capped.length).toBeGreaterThan(thereAndBack().length + 6)
  })

  it('never wanders further from the path than the path is wide', () => {
    // Everything stays within a metre of the line it is drawn along.
    for (const p of capTurnarounds(thereAndBack())) {
      const eastM = metresBetween(p, offset(ORIGIN, 0, (p[1] - ORIGIN[1]) * 111_320))
      expect(eastM).toBeLessThan(1)
    }
  })

  it('reaches the turnaround rather than stopping short of it', () => {
    const tip = offset(ORIGIN, 0, 100)
    const nearest = capTurnarounds(thereAndBack())
      .map((p) => metresBetween(p, tip))
      .sort((a, b) => a - b)[0]

    expect(nearest).toBeLessThan(0.2)
  })

  it('leaves the start and the end where they were', () => {
    const capped = capTurnarounds(thereAndBack())

    expect(metresBetween(capped[0], ORIGIN)).toBeLessThan(0.01)
    expect(metresBetween(capped[capped.length - 1], ORIGIN)).toBeLessThan(0.01)
  })

  it('has nothing to do to a route that never turns round', () => {
    const bend: LngLat[] = [ORIGIN, offset(ORIGIN, 100, 0), offset(ORIGIN, 100, 100)]

    expect(capTurnarounds(bend)).toEqual(bend)
  })
})
