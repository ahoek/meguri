import { reactive } from 'vue'
import {
  prepareRoute,
  locateOnRoute,
  locateInitial,
  nextManeuver,
  maneuverAfter,
  routeBearingAt,
  positionAtKm,
  segmentBearingAt,
  bearingAlong,
  AT_START_M,
} from '../domain/navigation'
import { speakManeuver, resetSpeech } from './guidance'
import {
  startCompass,
  stopCompass,
  compassHeading,
  compassStatus,
  simulateCompass,
} from '../infra/compass'
import { startSimulation, simulatedHeading } from '../infra/simulator'
import type { Simulation } from '../infra/simulator'
import { routeBetween } from '../infra/brouter'
import { distanceKm } from '../domain/geo'
import type { LngLat } from '../domain/geo'
import type { Route, Profile } from '../domain/route'
import type { Maneuver, PreparedRoute } from '../domain/navigation'

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
  then: (Maneuver & { gapM: number }) | null
  offRoute: boolean
  arrived: boolean
  voice: boolean
  rejoin: { coordinates: LngLat[]; distanceKm: number } | null
  rejoining: boolean
  /** Null on a real ride; the demo's controls when the GPS is being faked. */
  demo: { speed: number; paused: boolean; straying: boolean } | null
}

// What the demo offers. 1 is real time, which is the honest one and far too slow
// to show anybody.
export const DEMO_SPEEDS = [1, 4, 10]
const DEMO_DEFAULT_SPEED = 4

const ARRIVE_M = 25

// Consumer GPS wanders by tens of metres between buildings, so a single bad
// fix must not move you to the next street. Going off route has to be both
// far enough and sustained.
const OFF_ROUTE_M = 45
const OFF_ROUTE_FIXES = 3
const BACK_ON_ROUTE_M = 30

// The same reasoning for "you have left the start": one stray reading past the
// start's radius is not a departure.
const AWAY_FIXES = 2

// A fix from before the phone went into a pocket describes where you were, not
// where you are. Coming back to a screen full of stale conclusions is how
// navigation ended up announcing things that hadn't happened.
const STALE_FIX_MS = 20_000

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
  then: null, // the manoeuvre after that one, when it lands close behind it
  offRoute: false,
  arrived: false,
  // Off unless the rider turned it on before: speaking up uninvited is worse
  // than staying quiet until asked.
  voice: localStorage.getItem('meguri-voice') === 'on',
  rejoin: null, // { coordinates, distanceKm } path back after a wrong turn
  rejoining: false,
  demo: null,
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
let awayFixes = 0
// Have we actually seen the walker away from the start? Until we have, they
// cannot have gone round, however the route projection reads.
let leftStart = false
let haveFirstFix = false
let rejoinAbort: AbortController | null = null
let rejoinFrom: LngLat | null = null
let profileMode: Profile = 'walk'
let natureOn = true
let simulation: Simulation | null = null

/**
 * Nothing plausible happens faster than this.
 *
 * Except in a demo, where the whole point is that it does: a five-kilometre
 * loop at walking pace is not something you can show anybody. Scaling the
 * ceiling keeps the guard doing its job proportionally — a sped-up walk gets
 * through, a jump to the far side of the loop still doesn't.
 */
function speedCeiling() {
  return MAX_SPEED_KMH[profileMode] * (nav.demo?.speed ?? 1)
}

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
  if (!nav.active || document.visibilityState !== 'visible') return
  if (!wakeLock) acquireWakeLock()
  // Back from a spell in a pocket: say we don't know where we are rather than
  // leaving the last banner standing until the GPS catches up.
  if (lastFixAt && Date.now() - lastFixAt > STALE_FIX_MS) nav.ready = false
}

/**
 * Update the speed estimates from this fix.
 *
 * Zero is a real measurement, not noise: discarding it was what kept the
 * display gliding forward at riding speed while the rider stood still.
 */
function updatePace(gpsSpeed: number | null, advancedKm: number, dtSec: number) {
  const ceiling = speedCeiling()
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

/**
 * How much of the sideways gap between the road's centreline and the GPS to
 * keep.
 *
 * Snapping hard to the line is a lie you can see out of the corner of your
 * eye: you walk the right-hand pavement and the arrow sits out among the cars.
 * The route decides how far along you are — that has to stay smooth, or the
 * distance to the turn jitters — but which side of it you are on is something
 * the GPS actually knows, so keep that part of the reading.
 */
const OFFSET_SMOOTHING = 0.5
// Beyond this the "offset" is not a pavement, it is a bad fix or a parallel
// street, and drawing it would say we know something we don't.
const MAX_OFFSET_M = 20
// A fix this vague cannot tell one side of a road from the other; following it
// would only add wobble.
const OFFSET_ACCURACY_M = 30
const M_PER_DEG_LAT = 111_320

let offsetLng = 0
let offsetLat = 0

function updateLateralOffset(
  position: LngLat,
  snapped: LngLat,
  accuracy: number | null,
) {
  let dLng = 0
  let dLat = 0

  if (accuracy == null || accuracy <= OFFSET_ACCURACY_M) {
    dLng = position[0] - snapped[0]
    dLat = position[1] - snapped[1]
    // Cap in metres rather than degrees: a degree of longitude is two thirds
    // of a degree of latitude at these latitudes and shrinks further north.
    const perDegLng = M_PER_DEG_LAT * Math.cos((position[1] * Math.PI) / 180)
    const east = dLng * perDegLng
    const north = dLat * M_PER_DEG_LAT
    const away = Math.hypot(east, north)
    if (away > MAX_OFFSET_M) {
      const keep = MAX_OFFSET_M / away
      dLng *= keep
      dLat *= keep
    }
  }

  // Eased, so a single noisy fix nudges the arrow rather than shoving it.
  offsetLng += (dLng - offsetLng) * OFFSET_SMOOTHING
  offsetLat += (dLat - offsetLat) * OFFSET_SMOOTHING
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

  const ceiling = speedCeiling()
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

  // Standing near the start, the finish is under your feet too. Refuse to be
  // relocated across the loop until we have watched you leave.
  if (!leftStart) {
    const fromStartM = distanceKm(position, prepared!.coords[0]) * 1000
    awayFixes = fromStartM > AT_START_M ? awayFixes + 1 : 0
    if (awayFixes >= AWAY_FIXES) leftStart = true
  }

  const fix = haveFirstFix
    ? locateOnRoute(prepared!, position, lastIndex, { relocate: leftStart })
    : locateInitial(prepared!, position)

  const accepted = plausible(fix.alongKm, now)
  if (accepted) {
    const advanced = Math.max(0, fix.alongKm - alongKm)
    updatePace(speed, advanced, dtSec)
    lastIndex = fix.index
    alongKm = fix.alongKm
    maxAlongKm = Math.max(maxAlongKm, alongKm)
    nav.snapped = fix.snapped
    updateLateralOffset(position, fix.snapped, accuracy)
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
  nav.then = maneuver ? maneuverAfter(prepared!, maneuver.atKm) : null

  // The finish is also the start, so arriving requires having gone round —
  // and going round requires having left in the first place.
  const toFinishM = (prepared!.totalKm - alongKm) * 1000
  const wentRound = leftStart && maxAlongKm > prepared!.totalKm * 0.7
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

// Recompute once you've wandered this much further. Kept short enough that the
// head of the path stays within a step or two of you: past that the drawn path
// starts somewhere you are not, which is what the dotted leader has to cover.
const REJOIN_REFRESH_M = 30

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
  { mode = 'walk' as Profile, nature = true, demo = false } = {},
): boolean {
  if (!route) return false
  if (!demo && !('geolocation' in navigator)) return false

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
  awayFixes = 0
  leftStart = false
  haveFirstFix = false
  offsetLng = 0
  offsetLat = 0
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
    then: null,
    offRoute: false,
    arrived: false,
    demo: demo
      ? { speed: DEMO_DEFAULT_SPEED, paused: false, straying: false }
      : null,
  })

  if (demo) {
    simulation = startSimulation({
      route: prepared,
      paceKmh: DEFAULT_PACE_KMH[mode] ?? DEFAULT_PACE_KMH.walk,
      speed: DEMO_DEFAULT_SPEED,
      onFix: onPosition,
    })
    // A phone on a desk has a real magnetometer pointing at a real north, which
    // has nothing to do with the route it is pretending to walk. Left to the
    // hardware, every walking demo would be a demo of a wrong arrow.
    simulateCompass(() => simulatedHeading(prepared!, alongKm))
  } else {
    watchId = navigator.geolocation.watchPosition(onPosition, onPositionError, {
      enableHighAccuracy: true,
      maximumAge: 1000,
      timeout: 15000,
    })
    // Must be asked for inside the tap that got us here, or iOS refuses.
    if (mode === 'walk') startCompass()
  }

  acquireWakeLock()
  document.addEventListener('visibilitychange', onVisibility)
  return true
}

/** How fast the demo walks the route. Real time is 1. */
export function setDemoSpeed(factor: number) {
  if (!nav.demo) return
  nav.demo.speed = factor
  simulation?.setSpeed(factor)
}

/** Stand still, to talk over the screen without the map running away. */
export function toggleDemoPaused() {
  if (!nav.demo) return
  nav.demo.paused = !nav.demo.paused
  simulation?.setPaused(nav.demo.paused)
}

/** Take a wrong turn on purpose, and later find the way back. */
export function toggleDemoStraying() {
  if (!nav.demo) return
  nav.demo.straying = !nav.demo.straying
  simulation?.setStraying(nav.demo.straying)
}

export function stopNavigation() {
  if (watchId != null) navigator.geolocation.clearWatch(watchId)
  watchId = null
  simulation?.stop()
  simulation = null
  simulateCompass(null)
  document.removeEventListener('visibilitychange', onVisibility)
  releaseWakeLock()
  stopCompass()
  resetSpeech()
  prepared = null
  nav.demo = null
  nav.active = false
  nav.maneuver = null
  nav.then = null
  nav.position = null
  nav.snapped = null
  nav.rejoin = null
  rejoinAbort?.abort()
  rejoinFrom = null
}

/**
 * Which way to point the arrow and aim the camera.
 *
 * On a bike the route's own direction is steadier than anything the phone
 * reports, and the phone is usually strapped down facing forwards anyway. On
 * foot it is the other way round: you hold the phone the way you are looking,
 * and course over ground is noise until you are moving properly. So walking
 * follows the compass, and falls back to the road when there is no reading.
 */
export function deviceHeading(): number | null {
  return profileMode === 'walk' ? compassHeading() : null
}

/** True while the compass is the thing steering the arrow. */
export function usingCompass() {
  return profileMode === 'walk'
}

export { compassStatus }

/**
 * Ask again, from a fresh tap.
 *
 * iOS remembers a refusal per origin and will not prompt a second time, and a
 * session resumed on page load never had a gesture to ask from in the first
 * place. Either way the only route back is the rider tapping something.
 */
export function retryCompass() {
  return startCompass()
}

/**
 * How much of the gap to a fresh fix to close per frame, and how far we may
 * guess ahead between fixes.
 *
 * A walker covers 1.4 m/s, so there is little to gain from dead reckoning and
 * plenty to lose — every guessed metre is one that may have to be taken back. A
 * rider covers four times that, where carrying the position forward is what
 * keeps the map from lurching.
 *
 * Walking closes the gap slowly all the same. Fixes arrive about once a second;
 * at the old rate the arrow covered the metre and a half between them inside a
 * sixth of one and then stood still for the rest, which reads as a pulse rather
 * than as walking. Easing over most of the second costs about fifteen extra
 * centimetres of lag and buys continuous motion — and it is still only ever
 * interpolating towards a position we have been given, never inventing one
 * beyond it, which is the part that would have to be taken back.
 */
export function reckoning() {
  return profileMode === 'walk'
    ? { maxSeconds: 0, damping: 0, maxKm: 0, positionEase: 0.09 }
    : { maxSeconds: 3, damping: 0.5, maxKm: 0.012, positionEase: 0.1 }
}

// Below this the arrow stays put rather than creeping along on a stale pace.
const MOVING_KMH = 1.5

export interface Projection {
  position: LngLat
  index: number
  bearing: number | null
  cameraBearing: number | null
  /**
   * The sideways shift already applied to `position`, in degrees. Anything
   * that has to sit *on* the route — the grey trail behind you — takes it back
   * out rather than inheriting the wobble.
   */
  offset: [number, number]
}

/**
 * Where we believe the rider is right now, between fixes, and which way to
 * face them.
 *
 * Policy rather than drawing: the map asks this every frame and does as it is
 * told. It lives beside `reckoning()` because the two answer halves of the
 * same question, and splitting them across layers is what let the dead
 * reckoning figures go stale in the component without anyone noticing.
 */
export function projectedPosition(): Projection | null {
  if (!prepared) return null

  // On foot this is the compass: the arrow points where you are facing, not
  // where the road runs, so turning on the spot turns the map with you.
  const device = deviceHeading()

  if (nav.offRoute || !nav.fixAt) {
    // Off the route, show where you actually are — not where you'd be if you
    // were still on it. Seeing the gap is the whole point of the warning.
    const raw = nav.offRoute ? nav.position : (nav.snapped ?? nav.position)
    const heading = device ?? nav.heading
    return raw
      ? {
          position: raw,
          index: lastIndex,
          bearing: heading,
          cameraBearing: heading,
          offset: [0, 0],
        }
      : null
  }

  const { maxSeconds, damping, maxKm } = reckoning()
  const elapsed = Math.min((performance.now() - nav.fixAt) / 1000, maxSeconds)
  const ahead =
    nav.stationary || nav.paceKmh < MOVING_KMH
      ? 0 // standing still: the arrow stays put
      : Math.min((nav.paceKmh / 3600) * elapsed * damping, maxKm)
  const km = nav.alongKm + ahead
  const { position, index } = positionAtKm(prepared, km)
  return {
    // Along the route from the projection, sideways from the GPS: the two
    // things each source is actually good at.
    position: [position[0] + offsetLng, position[1] + offsetLat],
    index,
    // The arrow shows the road you are on, measured from where you stand on
    // the line rather than from the offset point beside it: which road that is
    // remains the route's business, and a metre sideways must not tilt it.
    bearing: device ?? segmentBearingAt(prepared, index, position),
    // The camera aims further ahead so it turns smoothly instead of snapping.
    cameraBearing: device ?? bearingAlong(prepared, km),
    offset: [offsetLng, offsetLat],
  }
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
  // `projectedPosition` among them: where the arrow is drawn is a conclusion
  // drawn from several fixes, and reading it back off a pitched marker's DOM
  // box turns a metre sideways into thirty.
  ;(window as any).__navSession = {
    nav,
    preparedRoute,
    currentIndex,
    projectedPosition,
  }
}
