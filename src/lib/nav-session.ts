import { reactive } from 'vue'
import {
  prepareRoute,
  locateOnRoute,
  locateInitial,
  nextManeuver,
  routeBearingAt,
} from './navigation'
import { speakManeuver, resetSpeech } from './speech'
import { routeBetween } from './route'
import { distanceKm } from './geo'
import type { LngLat } from './geo'
import type { Route, Profile } from './route'
import type { Maneuver, PreparedRoute } from './navigation'

interface NavState {
  active: boolean
  ready: boolean
  position: LngLat | null
  snapped: LngLat | null
  heading: number | null
  accuracy: number | null
  alongKm: number
  remainingKm: number
  remainingSec: number
  paceKmh: number
  stationary: boolean
  fixAt: number
  maneuver: (Maneuver & { distanceM: number }) | null
  offRoute: boolean
  arrived: boolean
  voice: boolean
  rejoin: { coordinates: LngLat[]; distanceKm: number } | null
  rejoining: boolean
}

const ARRIVE_M = 25

// Consumer GPS wanders by tens of metres between buildings, so a single bad
// fix must not move you to the next street. Going off route has to be both
// far enough and sustained.
const OFF_ROUTE_M = 45
const OFF_ROUTE_FIXES = 3
const BACK_ON_ROUTE_M = 30

// Nothing plausible happens faster than this, whatever the GPS claims.
const MAX_SPEED_KMH: Record<Profile, number> = { walk: 12, bike: 45 }
const DEFAULT_PACE_KMH: Record<Profile, number> = { walk: 4.8, bike: 16 }

// Two different speeds, because they answer different questions.
// `paceKmh` is how fast you are going *now* — it must fall to zero the moment
// you stop, or the display keeps sliding forward while you stand still. It is
// smoothed lightly so it reacts quickly.
const PACE_SMOOTHING = 0.4
// `movingPaceKmh` is how fast you travel when you are travelling, used for
// arrival time. Waiting at a light shouldn't push your ETA to infinity, so
// this one only samples while actually moving, and smooths heavily.
const MOVING_PACE_SMOOTHING = 0.12
const MOVING_THRESHOLD_KMH = 2.5

export const nav = reactive<NavState>({
  active: false,
  ready: false, // a GPS fix has arrived
  position: null, // [lng, lat] raw GPS
  snapped: null, // [lng, lat] projected onto the route — what we display
  heading: null, // degrees; the route's direction while we're on it
  accuracy: null,
  alongKm: 0,
  remainingKm: 0,
  remainingSec: 0,
  paceKmh: 0, // smoothed, for dead reckoning between fixes
  stationary: true, // the device says you are not moving — never extrapolate
  fixAt: 0, // performance.now() of the last accepted fix
  maneuver: null, // { kind, distanceM, exit }
  offRoute: false,
  arrived: false,
  // Off unless the rider turned it on before: speaking up uninvited is worse
  // than staying quiet until asked.
  voice: localStorage.getItem('meguri-voice') === 'on',
  rejoin: null, // { coordinates, distanceKm } path back after a wrong turn
  rejoining: false,
})

let prepared: PreparedRoute | null = null
let watchId: number | null = null
let wakeLock: WakeLockSentinel | null = null
let lastIndex = 0
let alongKm = 0
let maxAlongKm = 0
let paceKmh = 0
let movingPaceKmh = DEFAULT_PACE_KMH.walk
let lastFixAt = 0
let lastAcceptedAt = 0
let doubts = 0
let strayFixes = 0
let haveFirstFix = false
let rejoinAbort: AbortController | null = null
let rejoinFrom: LngLat | null = null
let profileMode: Profile = 'walk'
let natureOn = true

export function setVoice(on: boolean) {
  nav.voice = on
  try {
    localStorage.setItem('meguri-voice', on ? 'on' : 'off')
  } catch {
    /* storage blocked — preference just won't persist */
  }
  if (!on) resetSpeech()
}

async function acquireWakeLock() {
  try {
    wakeLock = (await navigator.wakeLock?.request('screen')) ?? null
  } catch {
    /* denied or unsupported — navigation still works, screen may sleep */
  }
}

function releaseWakeLock() {
  wakeLock?.release?.().catch(() => {})
  wakeLock = null
}

// iOS drops the wake lock whenever the tab is backgrounded.
function onVisibility() {
  if (nav.active && document.visibilityState === 'visible' && !wakeLock) {
    acquireWakeLock()
  }
}

/**
 * Update the speed estimates from this fix.
 *
 * Zero is a real measurement, not noise: discarding it was what kept the
 * display gliding forward at riding speed while the rider stood still.
 */
function updatePace(gpsSpeed: number | null, advancedKm: number, dtSec: number) {
  const ceiling = MAX_SPEED_KMH[profileMode]
  let sample: number | null = null

  if (typeof gpsSpeed === 'number' && !Number.isNaN(gpsSpeed) && gpsSpeed >= 0) {
    sample = gpsSpeed * 3.6
  } else if (dtSec >= 1) {
    // No speed from the device — derive it from progress along the route.
    sample = (advancedKm / dtSec) * 3600
  }

  if (sample == null) return
  if (sample > ceiling) return // a GPS spike, not a person

  if (sample < MOVING_THRESHOLD_KMH) {
    // A stop is not a trend to be averaged into — take it at face value.
    paceKmh = sample
  } else {
    paceKmh += (sample - paceKmh) * PACE_SMOOTHING
  }
  paceKmh = Math.min(Math.max(paceKmh, 0), ceiling)

  if (sample >= MOVING_THRESHOLD_KMH) {
    movingPaceKmh += (sample - movingPaceKmh) * MOVING_PACE_SMOOTHING
    movingPaceKmh = Math.min(Math.max(movingPaceKmh, 1.5), ceiling)
  }
}

// Give up doubting after this many fixes in a row: if the GPS keeps insisting,
// it is right and our idea of where we are is stale.
const MAX_DOUBTS = 3

/**
 * Reject progress that no walker or cyclist could have made. Without this a
 * stray reading near the far side of the loop can jump you to the end of the
 * route — including announcing arrival at the start, where the finish sits on
 * top of you.
 *
 * The allowance grows with the time since the last *accepted* fix, not the
 * last fix of any kind. Otherwise a single rejection freezes progress: the
 * budget never widens, so every later fix looks like an impossible leap and
 * navigation silently stops following you.
 */
function plausible(candidateKm: number, nowMs: number) {
  if (!haveFirstFix) return true
  if (doubts >= MAX_DOUBTS) return true

  const ceiling = MAX_SPEED_KMH[profileMode]
  const stuckSec = Math.max((nowMs - lastAcceptedAt) / 1000, 1)
  const allowanceKm = (ceiling / 3600) * stuckSec + 0.03
  const delta = candidateKm - alongKm
  if (delta > allowanceKm) return false
  // Small backward corrections are normal; a big one is a bad fix.
  if (delta < -Math.max(allowanceKm, 0.05)) return false
  return true
}

function onPosition(pos: GeolocationPosition) {
  const { longitude, latitude, heading, speed, accuracy } = pos.coords
  const position: LngLat = [longitude, latitude]
  const now = pos.timestamp || Date.now()
  const dtSec = lastFixAt ? Math.max((now - lastFixAt) / 1000, 0.5) : 1

  nav.ready = true
  nav.position = position
  nav.accuracy = accuracy

  const fix = haveFirstFix
    ? locateOnRoute(prepared!, position, lastIndex)
    : locateInitial(prepared!, position)

  const accepted = plausible(fix.alongKm, now)
  if (accepted) {
    const advanced = Math.max(0, fix.alongKm - alongKm)
    updatePace(speed, advanced, dtSec)
    lastIndex = fix.index
    alongKm = fix.alongKm
    maxAlongKm = Math.max(maxAlongKm, alongKm)
    nav.snapped = fix.snapped
    lastAcceptedAt = now
    doubts = 0
  } else {
    // Keep the last believable position rather than teleporting.
    doubts += 1
    updatePace(speed, 0, dtSec)
  }

  if (!haveFirstFix) lastAcceptedAt = now
  haveFirstFix = true
  lastFixAt = now

  // Off-route has to persist before we believe it, and clear decisively.
  if (fix.offRouteM > OFF_ROUTE_M) strayFixes += 1
  else if (fix.offRouteM < BACK_ON_ROUTE_M) strayFixes = 0
  nav.offRoute = strayFixes >= OFF_ROUTE_FIXES

  // Believe the device over our own estimate: a reported speed settles the
  // question of whether you are moving on this very fix, with no filter to
  // decay through first. Only fall back to the estimate if it says nothing.
  const reportedKmh =
    typeof speed === 'number' && !Number.isNaN(speed) && speed >= 0
      ? speed * 3.6
      : null
  nav.stationary =
    reportedKmh != null
      ? reportedKmh < MOVING_THRESHOLD_KMH
      : paceKmh < MOVING_THRESHOLD_KMH

  nav.alongKm = alongKm
  nav.paceKmh = paceKmh
  nav.fixAt = performance.now()
  nav.remainingKm = Math.max(0, prepared!.totalKm - alongKm)
  nav.remainingSec = (nav.remainingKm / movingPaceKmh) * 3600

  // Point the way the route runs, not the way the GPS thinks you're facing:
  // course over ground is wild at walking pace and jitters on a bike.
  nav.heading = nav.offRoute
    ? (typeof heading === 'number' && !Number.isNaN(heading)
        ? heading
        : nav.heading)
    : routeBearingAt(prepared!, lastIndex)

  const maneuver = nav.offRoute ? null : nextManeuver(prepared!, alongKm)
  nav.maneuver = maneuver

  // The finish is also the start, so arriving requires having gone round.
  const toFinishM = (prepared!.totalKm - alongKm) * 1000
  const wentRound = maxAlongKm > prepared!.totalKm * 0.7
  nav.arrived = wentRound && toFinishM < ARRIVE_M

  if (nav.offRoute) {
    maybeRejoin(position, fix)
  } else if (nav.rejoin) {
    rejoinAbort?.abort()
    rejoinFrom = null
    nav.rejoin = null
    nav.rejoining = false
  }

  if (nav.voice) {
    speakManeuver({ maneuver, arrived: nav.arrived, offRoute: nav.offRoute })
  }
}

const REJOIN_REFRESH_M = 45 // recompute once you've wandered this much further

/**
 * Route from where you actually are back to the loop. The loop itself is never
 * rewritten — a round trip of a chosen length only stays that if it survives
 * intact — so this is a separate "get back on" path.
 */
async function maybeRejoin(position: LngLat, fix: { index: number }) {
  if (nav.rejoining) return
  if (rejoinFrom && distanceKm(rejoinFrom, position) * 1000 < REJOIN_REFRESH_M) {
    return
  }

  // Aim a little ahead of the nearest point so the path leads forward along
  // the loop rather than doubling back to where you left it.
  const lookahead = Math.min(fix.index + 8, prepared!.coords.length - 1)
  const target = prepared!.coords[lookahead]

  nav.rejoining = true
  rejoinAbort?.abort()
  rejoinAbort = new AbortController()
  try {
    const path = await routeBetween({
      points: [position, target],
      profile: profileMode,
      nature: natureOn,
      signal: rejoinAbort.signal,
    })
    rejoinFrom = position
    nav.rejoin = {
      coordinates: path.geometry.coordinates,
      distanceKm: path.distanceKm,
    }
  } catch {
    /* offline or unroutable — the warning still shows */
  } finally {
    nav.rejoining = false
  }
}

function onPositionError() {
  nav.ready = false
}

export function startNavigation(
  route: Route | null,
  { mode = 'walk' as Profile, nature = true } = {},
): boolean {
  if (!route) return false
  if (!('geolocation' in navigator)) return false

  profileMode = mode
  natureOn = nature
  prepared = prepareRoute(route)
  lastIndex = 0
  alongKm = 0
  maxAlongKm = 0
  paceKmh = 0
  movingPaceKmh = DEFAULT_PACE_KMH[mode] ?? DEFAULT_PACE_KMH.walk
  lastFixAt = 0
  lastAcceptedAt = 0
  doubts = 0
  strayFixes = 0
  haveFirstFix = false
  resetSpeech()

  rejoinFrom = null
  Object.assign(nav, {
    rejoin: null,
    rejoining: false,
    active: true,
    ready: false,
    position: null,
    snapped: null,
    heading: null,
    accuracy: null,
    alongKm: 0,
    paceKmh,
    stationary: true,
    fixAt: 0,
    remainingKm: prepared.totalKm,
    remainingSec: (prepared.totalKm / movingPaceKmh) * 3600,
    maneuver: null,
    offRoute: false,
    arrived: false,
  })

  watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
    enableHighAccuracy: true,
    maximumAge: 1000,
    timeout: 15000,
  })
  acquireWakeLock()
  document.addEventListener('visibilitychange', onVisibility)
  return true
}

export function stopNavigation() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId)
  watchId = null
  document.removeEventListener('visibilitychange', onVisibility)
  releaseWakeLock()
  resetSpeech()
  prepared = null
  nav.active = false
  nav.maneuver = null
  nav.position = null
  nav.snapped = null
  nav.rejoin = null
  rejoinAbort?.abort()
  rejoinFrom = null
}

/** Exposed so the map can draw the traveled/remaining split. */
export function preparedRoute() {
  return prepared
}

export function currentIndex() {
  return lastIndex
}

// Navigation can't be exercised without physically moving, so in dev expose
// the live session for simulated GPS traces. Stripped from production builds.
if (import.meta.env.DEV) {
  ;(window as any).__navSession = { nav, preparedRoute, currentIndex }
}
