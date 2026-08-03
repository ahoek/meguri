import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSimulation } from '../src/infra/simulator'
import { prepareRoute, locateOnRoute } from '../src/domain/navigation'
import { squareLoop, metresBetween } from './helpers'
import type { PreparedRoute } from '../src/domain/navigation'

/**
 * The demo exists so navigation can be shown without going outside, which
 * means it has to behave like a receiver rather than like a script: fixes that
 * wander, a pace that drifts, and a wrong turn on request. A simulator that
 * reported the exact centreline would demonstrate a navigator nobody has.
 */

const loop = () => prepareRoute(squareLoop())

interface Fix {
  lngLat: [number, number]
  speedKmh: number
}

/** Collect what the simulator emits over `seconds` of its one-second ticks. */
function run(
  route: PreparedRoute,
  seconds: number,
  opts: { speed?: number; paceKmh?: number } = {},
) {
  const fixes: Fix[] = []
  const sim = startSimulation({
    route,
    paceKmh: opts.paceKmh ?? 4.8,
    speed: opts.speed ?? 1,
    onFix: (pos) =>
      fixes.push({
        lngLat: [pos.coords.longitude, pos.coords.latitude],
        speedKmh: (pos.coords.speed ?? 0) * 3.6,
      }),
  })
  vi.advanceTimersByTime(seconds * 1000)
  return { fixes, sim }
}

const strayM = (route: PreparedRoute, fix: Fix) =>
  locateOnRoute(route, fix.lngLat, 0).offRouteM

let running: { stop(): void } | null = null

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  running?.stop()
  running = null
  vi.useRealTimers()
})

describe('the demo walker', () => {
  // A real watch answers promptly; waiting a whole interval would put the
  // "waiting for GPS" banner on screen at the start of every demo.
  it('reports a first fix without waiting for a tick', () => {
    const route = loop()
    const { fixes, sim } = run(route, 0)
    running = sim
    expect(fixes).toHaveLength(1)
  })

  it('sets off along the route at the pace it was given', () => {
    const route = loop()
    const { fixes, sim } = run(route, 60, { paceKmh: 4.8, speed: 1 })
    running = sim

    // 4.8 km/h for a minute is 80 m, and it should be 80 m along the line
    // rather than 80 m from where it started in a straight line.
    const along = locateOnRoute(route, fixes[fixes.length - 1].lngLat, 0).alongKm
    expect(along * 1000).toBeGreaterThan(60)
    expect(along * 1000).toBeLessThan(100)
  })

  it('covers proportionally more ground when sped up', () => {
    const route = loop()
    // One at a time: advancing the clock drives every interval still alive, so
    // a second walker left running would be given the first one's minute too.
    const slow = run(route, 60, { speed: 1 })
    slow.sim.stop()
    const fast = run(route, 60, { speed: 4 })
    fast.sim.stop()

    const end = (fixes: Fix[]) =>
      locateOnRoute(route, fixes[fixes.length - 1].lngLat, 0).alongKm
    expect(end(fast.fixes)).toBeGreaterThan(end(slow.fixes) * 3)
  })

  // Welded to the centreline, the demo would never exercise the sideways
  // offset the real navigator spends its time deciding about.
  it('scatters its fixes the way a receiver does', () => {
    const route = loop()
    const { fixes, sim } = run(route, 40)
    running = sim

    const strays = fixes.map((f) => strayM(route, f))
    expect(Math.max(...strays)).toBeGreaterThan(0.5)
    // But scatter, not a wrong turn: nothing here should trip the warning.
    expect(Math.max(...strays)).toBeLessThan(15)
    expect(new Set(strays.map((s) => s.toFixed(3))).size).toBeGreaterThan(1)
  })

  it('drifts its pace instead of holding one figure', () => {
    const route = loop()
    const { fixes, sim } = run(route, 30)
    running = sim
    expect(new Set(fixes.map((f) => f.speedKmh.toFixed(4))).size).toBeGreaterThan(1)
  })

  it('stands still when paused, and says so', () => {
    const route = loop()
    const { fixes, sim } = run(route, 20)
    running = sim
    const before = fixes.length

    sim.setPaused(true)
    vi.advanceTimersByTime(10_000)
    const paused = fixes.slice(before)

    // Still reporting — a stopped walker is not a lost signal.
    expect(paused.length).toBeGreaterThan(5)
    expect(paused.every((f) => f.speedKmh === 0)).toBe(true)
    // And not moving.
    const spread = paused.map((f) => locateOnRoute(route, f.lngLat, 0).alongKm)
    expect(Math.max(...spread) - Math.min(...spread)).toBeLessThan(0.02)
  })

  it('wanders far enough off to be called a wrong turn, then comes back', () => {
    const route = loop()
    const { fixes, sim } = run(route, 30)
    running = sim

    sim.setStraying(true)
    vi.advanceTimersByTime(15_000)
    const away = strayM(route, fixes[fixes.length - 1])
    // Past the 45 m the navigator needs before it will believe you are lost.
    expect(away).toBeGreaterThan(60)

    sim.setStraying(false)
    vi.advanceTimersByTime(15_000)
    expect(strayM(route, fixes[fixes.length - 1])).toBeLessThan(15)
  })

  it('stops at the finish rather than running off the end', () => {
    const route = loop()
    // Far more time than the loop takes, at a pace that would overshoot it.
    const { fixes, sim } = run(route, 600, { paceKmh: 4.8, speed: 10 })
    running = sim

    // Compared against the last coordinate rather than a distance along the
    // line: on a loop the finish sits on the start, so "how far along" cannot
    // tell the two apart — which is the ambiguity navigation itself wrestles
    // with. Only jitter should separate us from the end of the route.
    const finish = route.coords[route.coords.length - 1]
    expect(metresBetween(fixes[fixes.length - 1].lngLat, finish)).toBeLessThan(20)

    // And it has settled there rather than still creeping.
    const tail = fixes.slice(-5)
    for (const f of tail) {
      expect(metresBetween(f.lngLat, finish)).toBeLessThan(20)
    }
  })

  it('emits nothing more once stopped', () => {
    const route = loop()
    const { fixes, sim } = run(route, 10)
    const settled = fixes.length
    sim.stop()
    vi.advanceTimersByTime(20_000)
    expect(fixes).toHaveLength(settled)
  })
})
