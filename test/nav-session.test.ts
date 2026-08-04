import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { locateOnRoute, positionAtKm, prepareRoute } from '../src/domain/navigation'
import { squareLoop, ORIGIN, offset } from './helpers'
import type { LngLat } from '../src/domain/geo'
import type { PreparedRoute } from '../src/domain/navigation'

type NavModule = typeof import('../src/app/nav-session')
type FixCallback = (pos: {
  timestamp: number
  coords: {
    longitude: number
    latitude: number
    accuracy: number
    heading: number | null
    speed: number | null
  }
}) => void

// A controllable stand-in for the phone's GPS.
let listener: FixCallback | null = null
let clock = 0

function installGeolocation() {
  listener = null
  clock = Date.now()
  ;(globalThis as any).navigator ??= {}
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      watchPosition: (ok: FixCallback) => {
        listener = ok
        return 1
      },
      clearWatch: () => {
        listener = null
      },
      getCurrentPosition: () => {},
    },
  })
}

/** Deliver a fix, advancing the clock by `afterSec`. */
function fix(
  position: LngLat,
  { speed = null as number | null, afterSec = 3, accuracy = 8 } = {},
) {
  clock += afterSec * 1000
  listener?.({
    timestamp: clock,
    coords: {
      longitude: position[0],
      latitude: position[1],
      accuracy,
      heading: null,
      speed,
    },
  })
}

let nav: NavModule['nav']
let startNavigation: NavModule['startNavigation']
let stopNavigation: NavModule['stopNavigation']
let projectedPosition: NavModule['projectedPosition']

beforeEach(async () => {
  installGeolocation()
  // Leaving the route triggers a routing request for the way back; these
  // tests are about the tracking decisions, not the network.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  vi.resetModules()
  const mod = await import('../src/app/nav-session')
  nav = mod.nav
  startNavigation = mod.startNavigation
  stopNavigation = mod.stopNavigation
  projectedPosition = mod.projectedPosition
})

afterEach(() => {
  stopNavigation?.()
  vi.unstubAllGlobals()
})

const loop = () => {
  const route = squareLoop()
  return { route, prepared: prepareRoute(route) }
}

/** Ride to `km` along the route in realistic steps. */
function rideTo(p: PreparedRoute, km: number, { speed = 5, stepKm = 0.015 } = {}) {
  for (let at = nav.alongKm + stepKm; at <= km; at += stepKm) {
    fix(positionAtKm(p, at).position, { speed })
  }
}

describe('starting navigation', () => {
  it('begins at the start of the loop, not at its finish', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })

    expect(nav.alongKm).toBe(0)
    expect(nav.arrived).toBe(false)
    expect(nav.remainingKm).toBeCloseTo(p.totalKm, 2)
  })

  it('only declares arrival after actually going round', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })

    rideTo(p, p.totalKm * 0.5)
    expect(nav.arrived).toBe(false)

    rideTo(p, p.totalKm)
    fix(p.coords[p.coords.length - 1], { speed: 1 })
    expect(nav.arrived).toBe(true)
  })

  // Reported from the road: leave the app sitting at the start, come back to
  // it much later, and the first fix would match the finish — which is the
  // same patch of pavement — with a plausibility budget grown wide enough by
  // the gap to wave it through. Navigation congratulated the rider on a loop
  // they had not begun.
  it('does not call it done after a long spell away from the screen', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })

    // Twenty minutes later, still on the doorstep, with a sloppy fix.
    fix(offset(ORIGIN, 70, 0), { speed: 0, afterSec: 20 * 60 })
    fix(offset(ORIGIN, 60, 10), { speed: 0, afterSec: 4 })

    expect(nav.arrived).toBe(false)
    expect(nav.alongKm).toBeLessThan(0.1)
    expect(nav.remainingKm).toBeCloseTo(p.totalKm, 1)
  })

  it('still catches up when the loop was ridden with the screen off', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.3) // seen leaving, so a later relocation is believable

    // Pocket for ten minutes, resurfacing three quarters of the way round.
    const later = positionAtKm(p, p.totalKm * 0.75).position
    fix(later, { speed: 5, afterSec: 10 * 60 })

    expect(nav.alongKm).toBeCloseTo(p.totalKm * 0.75, 1)
    expect(nav.arrived).toBe(false)
  })
})

describe('standing still', () => {
  // The arrow crept forward while the rider was stopped, because a reported
  // speed of zero was discarded as noise and the last riding speed persisted.
  it('drops the pace to zero when the device reports a stop', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.2, { speed: 5 }) // 18 km/h
    expect(nav.paceKmh).toBeGreaterThan(15)

    const here = positionAtKm(p, nav.alongKm).position
    for (let i = 0; i < 4; i++) fix(here, { speed: 0 })

    expect(nav.paceKmh).toBeLessThan(2)
    expect(nav.stationary).toBe(true)
  })

  it('keeps the arrival estimate sane while stopped', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.2, { speed: 5 })
    const moving = nav.remainingSec

    const here = positionAtKm(p, nav.alongKm).position
    for (let i = 0; i < 5; i++) fix(here, { speed: 0 })

    // Waiting at a light must not push the estimate towards infinity.
    expect(nav.remainingSec).toBeCloseTo(moving, -1)
    expect(Number.isFinite(nav.remainingSec)).toBe(true)
  })
})

describe('implausible fixes', () => {
  it('ignores a jump no rider could have made', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.3)
    const before = nav.alongKm

    fix(positionAtKm(p, p.totalKm * 0.85).position, { speed: 5 })
    expect(nav.alongKm).toBeCloseTo(before, 2)
    expect(nav.arrived).toBe(false)
  })

  // The first version of that guard froze navigation for good: the time
  // budget never widened, so every later fix also looked impossible.
  it('gives in when the GPS keeps insisting', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.3)

    const jumped = positionAtKm(p, p.totalKm * 0.85).position
    for (let i = 0; i < 5; i++) fix(jumped, { speed: 5 })

    expect(nav.alongKm).toBeCloseTo(p.totalKm * 0.85, 1)
  })

  it('keeps following after a single bad reading', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.2)

    fix(positionAtKm(p, p.totalKm * 0.9).position, { speed: 5 }) // nonsense
    const resumed = nav.alongKm + 0.1
    rideTo(p, resumed)

    expect(nav.alongKm).toBeGreaterThan(0.25)
    expect(nav.alongKm).toBeLessThan(p.totalKm * 0.5)
  })
})

/**
 * The route is a centreline; you are not on it. Snapping hard to it put the
 * arrow out among the cars while the walker was on the right-hand pavement,
 * which reads as the app not knowing where you are.
 */
describe('which side of the road', () => {
  /**
   * How far the drawn position sits from the centreline, in metres.
   *
   * `locateOnRoute` rather than `locateInitial`: the latter prefers the
   * earliest of several near-equal candidates, which on a loop this small
   * means it never leaves the first segment.
   */
  const strayM = (p: PreparedRoute) =>
    locateOnRoute(p, projectedPosition()!.position, 0).offRouteM

  /** Travel to 150 m along, then hold `metres` to one side of the line. */
  function stepAside(
    p: PreparedRoute,
    metres: number,
    { fixes = 4, accuracy = 8 } = {},
  ) {
    rideTo(p, 0.15)
    const online = positionAtKm(p, nav.alongKm + 0.02).position
    for (let i = 0; i < fixes; i++) {
      fix(offset(online, metres, 0), { speed: 4, accuracy })
    }
  }

  it('shows a walker beside the line, not on it', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'walk' })
    fix(ORIGIN, { speed: 0 })

    // Seven metres to the side: the right-hand pavement, not a wrong turn.
    stepAside(p, 7, { fixes: 3 })

    expect(nav.offRoute).toBe(false)
    expect(strayM(p)).toBeGreaterThan(4)
  })

  /**
   * On a bike the line is what you steer by, so ordinary scatter must not move
   * the arrow off it — but the GPS is not disbelieved either, only made to
   * insist first.
   */
  it('keeps a rider on the line through ordinary scatter', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })

    // The width of a cycle path plus a few metres of noise.
    stepAside(p, 7)

    expect(nav.offRoute).toBe(false)
    expect(strayM(p)).toBeLessThan(2)
  })

  it('moves a rider off the line once the GPS really insists', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })

    // Thirty metres is not the width of anything you could be riding on. Still
    // short of a wrong turn, but worth showing before one is declared.
    stepAside(p, 30)

    expect(nav.offRoute).toBe(false)
    expect(strayM(p)).toBeGreaterThan(8)
  })

  it('will not be dragged further than a road is wide', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })

    // A 40 m sideways reading is a bad fix or the next street over. Believing
    // it wholesale would draw the rider through the houses in between. Still
    // inside the 45 m a rider is allowed before being called lost, so this is
    // the cap doing the work rather than the off-route warning.
    stepAside(p, 40)

    expect(nav.offRoute).toBe(false)
    expect(strayM(p)).toBeLessThan(25)
  })

  /**
   * Where the cap stops and the warning starts. A walker is called off route at
   * 25 m, so there is no such thing as an honest 40 m sideways offset on foot —
   * past that it is not which side of the path you are on, it is a wrong turn,
   * and the display switches to showing where you actually are.
   */
  it('calls a big walking offset a wrong turn rather than a wide path', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'walk' })
    fix(ORIGIN, { speed: 0 })

    stepAside(p, 40)

    expect(nav.offRoute).toBe(true)
  })

  it('ignores the sideways part of a vague fix', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'walk' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.15)

    // Accurate to within 80 m: this cannot tell one kerb from the other, so
    // following it sideways would only add wobble.
    const online = positionAtKm(p, nav.alongKm + 0.02).position
    for (let i = 0; i < 4; i++) fix(offset(online, 15, 0), { speed: 4, accuracy: 80 })

    expect(strayM(p)).toBeLessThan(2)
  })
})

/**
 * Forty-five metres is ten seconds of riding; at walking pace it is half a
 * minute spent going the wrong way, which is a street and a half.
 */
describe('how soon a wrong turn is called', () => {
  const strayTo = (p: PreparedRoute, metres: number, accuracy = 8) => {
    rideTo(p, 0.2)
    const away = offset(positionAtKm(p, nav.alongKm).position, metres, 0)
    for (let i = 0; i < 3; i++) fix(away, { speed: 4, accuracy })
  }

  it('tells a walker at a distance a rider would still be allowed', () => {
    const walk = loop()
    startNavigation(walk.route, { mode: 'walk' })
    fix(ORIGIN, { speed: 0 })
    strayTo(walk.prepared, 32)
    expect(nav.offRoute).toBe(true)

    stopNavigation()

    const ride = loop()
    startNavigation(ride.route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    strayTo(ride.prepared, 32)
    // Same distance, still on the road you turned onto at riding speed.
    expect(nav.offRoute).toBe(false)
  })

  // The price of the tighter threshold: a fix that admits to ±40 m cannot be
  // evidence of being 30 m off course, and under trees that is a common reading.
  it('will not be talked into it by a vague fix', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'walk' })
    fix(ORIGIN, { speed: 0 })

    strayTo(p, 32, 40)
    expect(nav.offRoute).toBe(false)

    // The same place, reported sharply, is believed.
    const away = offset(positionAtKm(p, nav.alongKm).position, 32, 0)
    for (let i = 0; i < 3; i++) fix(away, { speed: 4, accuracy: 8 })
    expect(nav.offRoute).toBe(true)
  })
})

describe('leaving the route', () => {
  it('needs several fixes off the line before it complains', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.2)

    const away = offset(positionAtKm(p, nav.alongKm).position, 120, 90)
    fix(away, { speed: 4 })
    expect(nav.offRoute).toBe(false) // one stray reading is not a wrong turn

    fix(away, { speed: 4 })
    fix(away, { speed: 4 })
    expect(nav.offRoute).toBe(true)
  })

  it('clears once back on the line', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.2)

    const away = offset(positionAtKm(p, nav.alongKm).position, 120, 90)
    for (let i = 0; i < 3; i++) fix(away, { speed: 4 })
    expect(nav.offRoute).toBe(true)

    fix(positionAtKm(p, nav.alongKm + 0.01).position, { speed: 4 })
    expect(nav.offRoute).toBe(false)
  })

  it('stops announcing turns while off the route', () => {
    const { route, prepared: p } = loop()
    startNavigation(route, { mode: 'bike' })
    fix(ORIGIN, { speed: 0 })
    rideTo(p, 0.2)

    const away = offset(positionAtKm(p, nav.alongKm).position, 120, 90)
    for (let i = 0; i < 3; i++) fix(away, { speed: 4 })
    expect(nav.maneuver).toBeNull()
  })
})
