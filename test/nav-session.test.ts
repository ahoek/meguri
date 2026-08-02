import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { positionAtKm, prepareRoute } from '../src/lib/navigation'
import { squareLoop, ORIGIN, offset } from './helpers'
import type { LngLat } from '../src/lib/geo'
import type { PreparedRoute } from '../src/lib/navigation'

type NavModule = typeof import('../src/lib/nav-session')
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
function fix(position: LngLat, { speed = null as number | null, afterSec = 3 } = {}) {
  clock += afterSec * 1000
  listener?.({
    timestamp: clock,
    coords: {
      longitude: position[0],
      latitude: position[1],
      accuracy: 8,
      heading: null,
      speed,
    },
  })
}

let nav: NavModule['nav']
let startNavigation: NavModule['startNavigation']
let stopNavigation: NavModule['stopNavigation']

beforeEach(async () => {
  installGeolocation()
  // Leaving the route triggers a routing request for the way back; these
  // tests are about the tracking decisions, not the network.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  vi.resetModules()
  const mod = await import('../src/lib/nav-session')
  nav = mod.nav
  startNavigation = mod.startNavigation
  stopNavigation = mod.stopNavigation
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
