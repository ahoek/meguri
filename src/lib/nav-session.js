import { reactive } from 'vue'
import {
  prepareRoute,
  locateOnRoute,
  nextManeuver,
  bearingBetween,
} from './navigation.js'
import { speakManeuver, resetSpeech } from './speech.js'
import { findSpots, upcomingSpot } from './spots.js'
import { routeBetween } from './route.js'
import { distanceKm } from './geo.js'
import { locale } from '../i18n.js'

const OFF_ROUTE_M = 40
const ARRIVE_M = 25

export const nav = reactive({
  active: false,
  ready: false, // a GPS fix has arrived
  position: null, // [lng, lat] raw GPS
  snapped: null, // [lng, lat] projected onto the route
  heading: null, // degrees, course over ground
  accuracy: null,
  alongKm: 0,
  remainingKm: 0,
  remainingSec: 0,
  maneuver: null, // { kind, distanceM, exit }
  offRoute: false,
  arrived: false,
  voice: localStorage.getItem('meguri-voice') !== 'off',
  spots: [], // interesting places along the route
  spot: null, // the one you're passing right now
  rejoin: null, // { coordinates, distanceKm } path back after a wrong turn
  rejoining: false,
})

let prepared = null
let watchId = null
let wakeLock = null
let lastIndex = 0
let paceKmh = 5
let hasLeftStart = false
let spotsAbort = null
let rejoinAbort = null
let rejoinFrom = null // position the current rejoin path was computed from
let profileMode = 'walk'
let natureOn = true

export function setVoice(on) {
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
    wakeLock = await navigator.wakeLock?.request('screen')
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

function onPosition(pos) {
  const { longitude, latitude, heading, speed, accuracy } = pos.coords
  const position = [longitude, latitude]

  nav.ready = true
  nav.position = position
  nav.accuracy = accuracy
  if (typeof speed === 'number' && speed > 0.5) {
    paceKmh = speed * 3.6
  }

  const fix = locateOnRoute(prepared, position, lastIndex)
  lastIndex = fix.index

  nav.snapped = fix.snapped
  nav.alongKm = fix.alongKm
  nav.offRoute = fix.offRouteM > OFF_ROUTE_M
  nav.remainingKm = Math.max(0, prepared.totalKm - fix.alongKm)
  nav.remainingSec = (nav.remainingKm / Math.max(paceKmh, 1)) * 3600

  // A device heading is often absent when standing still; fall back to the
  // direction the route itself runs, so the map still orients sensibly.
  if (typeof heading === 'number' && !Number.isNaN(heading)) {
    nav.heading = heading
  } else {
    const ahead = prepared.coords[Math.min(fix.index + 1, prepared.coords.length - 1)]
    nav.heading = bearingBetween(fix.snapped, ahead)
  }

  const maneuver = nav.offRoute ? null : nextManeuver(prepared, fix.alongKm)
  nav.maneuver = maneuver

  // The finish is also the start, so only allow arrival once we have actually
  // set off — otherwise navigation "arrives" the moment it begins.
  if (fix.alongKm > 0.15) hasLeftStart = true
  const toFinishM = (prepared.totalKm - fix.alongKm) * 1000
  nav.arrived = hasLeftStart && toFinishM < ARRIVE_M

  nav.spot = nav.offRoute ? null : upcomingSpot(nav.spots, fix.alongKm)

  if (nav.offRoute) {
    maybeRejoin(position, fix)
  } else if (nav.rejoin) {
    // Back on the line — drop the detour guidance.
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
async function maybeRejoin(position, fix) {
  if (nav.rejoining) return
  if (rejoinFrom && distanceKm(rejoinFrom, position) * 1000 < REJOIN_REFRESH_M) {
    return
  }

  // Aim a little ahead of the nearest point so the path leads forward along
  // the loop rather than doubling back to where you left it.
  const lookahead = Math.min(fix.index + 8, prepared.coords.length - 1)
  const target = prepared.coords[lookahead]

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
    /* offline or unroutable — the arrow back to the line still shows */
  } finally {
    nav.rejoining = false
  }
}

/** Look up nearby points of interest; failures are silently ignored. */
export async function loadSpots(route) {
  spotsAbort?.abort()
  spotsAbort = new AbortController()
  const forRoute = prepareRoute(route)
  const found = await findSpots(forRoute, {
    signal: spotsAbort.signal,
    lang: locale.value,
  })
  nav.spots = found
  return found
}

function onPositionError() {
  nav.ready = false
}

export function startNavigation(route, { mode = 'walk', nature = true } = {}) {
  if (!('geolocation' in navigator)) return false

  profileMode = mode
  natureOn = nature
  prepared = prepareRoute(route)
  lastIndex = 0
  hasLeftStart = false
  paceKmh = 5
  resetSpeech()

  rejoinFrom = null
  Object.assign(nav, {
    spot: null,
    rejoin: null,
    rejoining: false,
    active: true,
    ready: false,
    position: null,
    snapped: null,
    heading: null,
    accuracy: null,
    alongKm: 0,
    remainingKm: prepared.totalKm,
    remainingSec: route.durationSec,
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
  nav.spot = null
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
  window.__navSession = { nav, preparedRoute, currentIndex }
}
