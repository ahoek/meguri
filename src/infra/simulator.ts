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

/**
 * Consumer GPS updates about this often, and pretending to be faster would make
 * the eased camera look smoother than it is on a real ride.
 *
 * But speeding up the demo has to speed up the receiver's clock with it. Held
 * at one second while the walker moves four times as fast, each fix lands four
 * times further on, and the map advances in strides no real pace produces —
 * which read as the app stuttering rather than the demo being fast. What has to
 * stay true to life is the metres between fixes, not the seconds.
 */
const FIX_INTERVAL_MS = 1000
// Not below this, however fast the demo runs: every fix is a route projection.
const MIN_FIX_INTERVAL_MS = 100

/**
 * Sideways scatter, in metres — the reason the arrow is drawn beside the line
 * rather than welded to it.
 *
 * The first version drew a fresh random offset every fix, which is white noise,
 * and white noise is not what a receiver does. Reported from a walk: too erratic,
 * deviating too far side to side. Both were true — the amplitude was half again
 * as much as a phone in the open manages, and independent samples once a second
 * read as vibration rather than as drift.
 *
 * Real error wanders: it holds a couple of metres to one side for a while, then
 * crosses over. So this is a random walk with a gentle pull back to the line, and
 * a hard bound, which gives the same character at a quarter of the fidget.
 */
const JITTER_M = 2.5
const JITTER_STEP_M = 0.45 // how far the wander can move between fixes
const JITTER_PULL = 0.08 // and how strongly it is drawn back to the centre
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
  let wanderM = 0
  let timer: ReturnType<typeof setTimeout> | undefined

  /** Faster demo, faster receiver — so the ground covered per fix holds. */
  function intervalMs() {
    return Math.max(FIX_INTERVAL_MS / speed, MIN_FIX_INTERVAL_MS)
  }

  function emit() {
    const bearing = bearingAlong(opts.route, alongKm)
    const paceKmh = paused
      ? 0
      : opts.paceKmh * speed * (1 + (Math.random() - 0.5) * PACE_WOBBLE)

    if (!paused) {
      alongKm = Math.min(
        alongKm + (paceKmh / 3600) * (intervalMs() / 1000),
        opts.route.totalKm,
      )
    }

    // Off the route, keep drifting further out until told otherwise; back on,
    // close the gap at the same rate rather than teleporting onto the line.
    strayM = straying
      ? Math.min(strayM + STRAY_GROWTH_M, STRAY_M)
      : Math.max(strayM - STRAY_GROWTH_M, 0)

    // A step in a random direction, less a nudge back towards the line, then
    // clamped — so it drifts and crosses over instead of buzzing.
    wanderM += (Math.random() - 0.5) * 2 * JITTER_STEP_M - wanderM * JITTER_PULL
    wanderM = Math.max(-JITTER_M, Math.min(JITTER_M, wanderM))

    const { position } = positionAtKm(opts.route, alongKm)
    const here = beside(position, bearing, strayM + wanderM)

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

  // Rescheduled each time rather than a fixed interval, because changing the
  // demo speed changes how often a fix is due.
  function schedule() {
    timer = setTimeout(() => {
      emit()
      schedule()
    }, intervalMs())
  }

  // A real watch delivers the first fix promptly rather than after a full
  // interval, and the wait is what the "waiting for GPS" banner is for.
  emit()
  schedule()

  return {
    stop() {
      clearTimeout(timer)
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

/**
 * Which way the simulated walker is facing, for the compass to answer with.
 *
 * Just the road ahead, and deliberately nothing more. A first version added a
 * few degrees of sway on the theory that a held phone is never still — but on
 * foot the camera takes its bearing from the compass, and follows it quickly
 * because a compass answers to your wrist. So four degrees of invented sway
 * became the entire map rocking back and forth every few seconds, which is not
 * a phone being held, it is a demo looking broken.
 */
export function simulatedHeading(route: PreparedRoute, alongKm: number): number {
  return bearingAlong(route, alongKm)
}
