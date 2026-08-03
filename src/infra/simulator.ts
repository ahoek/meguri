import { positionAtKm, bearingAlong } from '../domain/navigation'
import type { PreparedRoute } from '../domain/navigation'
import type { LngLat } from '../domain/geo'

/**
 * A stand-in for the phone's GPS that walks the route on its own.
 *
 * Navigation is the one part of this app that cannot be checked from a chair:
 * every fix has to be earned by going outside. That is fine for building it and
 * hopeless for showing it to somebody, so this drives a session from the route
 * itself — same shape of reading, same interval, same lies a real receiver
 * tells.
 *
 * The lies matter. A simulator that reports the exact centreline at the exact
 * pace demonstrates a navigator nobody has: the arrow would never wander off
 * the middle of the path, the sideways-offset handling would never be exercised
 * and the demo would show behaviour the real thing doesn't have. So the fixes
 * are noisy, the speed drifts, and it can be told to take a wrong turn.
 */

// Consumer GPS updates about this often, and pretending to be faster would make
// the eased camera look smoother than it is on a real ride.
const FIX_INTERVAL_MS = 1000

// Sideways scatter, in metres. Real fixes wander this much between buildings
// and under trees, and it is the reason the arrow is drawn beside the line
// rather than welded to it.
const JITTER_M = 3.5
// What the fixes claim about themselves. Optimistic but not absurd — and under
// the threshold above which nav-session stops trusting the sideways part.
const ACCURACY_M = 6

// Pace wanders: nobody holds a constant speed, and an ETA that never moves is
// not an ETA being tested.
const PACE_WOBBLE = 0.12

// A wrong turn, once asked for. Grows to this and holds, which is comfortably
// past the distance at which navigation starts objecting.
const STRAY_M = 110
const STRAY_GROWTH_M = 22 // per fix, so the warning takes a few to appear

const M_PER_DEG_LAT = 111_320
const mPerDegLng = (lat: number) => M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180)

export interface Simulation {
  stop(): void
  /** Real-time multiple. Higher gets round the loop faster. */
  setSpeed(factor: number): void
  /** Freeze in place, still reporting fixes — as standing still does. */
  setPaused(paused: boolean): void
  /** Wander away from the route, or come back to it. */
  setStraying(straying: boolean): void
}

interface Options {
  route: PreparedRoute
  /** True pace for the profile, before the demo multiplier. */
  paceKmh: number
  speed: number
  onFix: (fix: GeolocationPosition) => void
}

/**
 * Offset a point sideways from the route's direction of travel, in metres.
 * Positive is to the right of travel, which is the side a walker keeps to.
 */
function beside(position: LngLat, bearingDeg: number, metres: number): LngLat {
  const rad = ((bearingDeg + 90) * Math.PI) / 180
  return [
    position[0] + (Math.sin(rad) * metres) / mPerDegLng(position[1]),
    position[1] + (Math.cos(rad) * metres) / M_PER_DEG_LAT,
  ]
}

export function startSimulation(opts: Options): Simulation {
  let alongKm = 0
  let speed = opts.speed
  let paused = false
  let straying = false
  let strayM = 0
  let timer: ReturnType<typeof setInterval> | undefined

  function emit() {
    const bearing = bearingAlong(opts.route, alongKm)
    const paceKmh = paused
      ? 0
      : opts.paceKmh * speed * (1 + (Math.random() - 0.5) * PACE_WOBBLE)

    if (!paused) {
      alongKm = Math.min(
        alongKm + (paceKmh / 3600) * (FIX_INTERVAL_MS / 1000),
        opts.route.totalKm,
      )
    }

    // Off the route, keep drifting further out until told otherwise; back on,
    // close the gap at the same rate rather than teleporting onto the line.
    strayM = straying
      ? Math.min(strayM + STRAY_GROWTH_M, STRAY_M)
      : Math.max(strayM - STRAY_GROWTH_M, 0)

    const { position } = positionAtKm(opts.route, alongKm)
    const wander = (Math.random() - 0.5) * 2 * JITTER_M
    const here = beside(position, bearing, strayM + wander)

    opts.onFix({
      coords: {
        longitude: here[0],
        latitude: here[1],
        accuracy: ACCURACY_M,
        altitude: null,
        altitudeAccuracy: null,
        // Course over ground is the one thing a receiver reports and this can
        // give honestly, since we know which way we are going.
        heading: paused ? null : bearing,
        speed: (paceKmh * 1000) / 3600,
        toJSON: () => ({}),
      } as GeolocationCoordinates,
      timestamp: Date.now(),
      toJSON: () => ({}),
    } as GeolocationPosition)
  }

  // A real watch delivers the first fix promptly rather than after a full
  // interval, and the wait is what the "waiting for GPS" banner is for.
  emit()
  timer = setInterval(emit, FIX_INTERVAL_MS)

  return {
    stop() {
      clearInterval(timer)
      timer = undefined
    },
    setSpeed(factor: number) {
      speed = factor
    },
    setPaused(next: boolean) {
      paused = next
    },
    setStraying(next: boolean) {
      straying = next
    },
  }
}

/** Which way the simulated walker is facing, for the compass to answer with. */
export function simulatedHeading(route: PreparedRoute, alongKm: number): number {
  // A held phone sways; a compass reading that never moves looks broken.
  const sway = Math.sin(Date.now() / 900) * 4
  return (bearingAlong(route, alongKm) + sway + 360) % 360
}
