import { reactive, watch } from 'vue'
import { generateLoop } from './lib/route.js'
import { distanceKm } from './lib/geo.js'
import { reverseGeocode } from './lib/geocode.js'
import { locale } from './i18n.js'
import { nav, startNavigation } from './lib/nav-session.js'

export const SPEEDS = { walk: 4.8, bike: 16 } // km/h, for time → distance
export const RANGES = {
  walk: { km: { min: 1, max: 40, step: 0.5 }, min: { min: 15, max: 360, step: 15 } },
  bike: { km: { min: 5, max: 120, step: 1 }, min: { min: 15, max: 360, step: 15 } },
}

const START_KEY = 'meguri-start'
const PREFS_KEY = 'meguri-prefs'
const ROUTE_KEY = 'meguri-route'
const NAV_KEY = 'meguri-navigating'
const WAYPOINTS_KEY = 'meguri-waypoints'

function loadWaypoints() {
  try {
    const saved = JSON.parse(localStorage.getItem(WAYPOINTS_KEY))
    if (Array.isArray(saved)) {
      return saved.filter(
        (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]),
      )
    }
  } catch {
    /* corrupt or absent */
  }
  return []
}

/** The last generated route, so a refresh doesn't throw away your loop. */
function loadSavedRoute() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROUTE_KEY))
    if (saved?.route?.geometry?.coordinates?.length > 1) return saved
  } catch {
    /* corrupt — fall through to a clean start */
  }
  return null
}

/** Planner settings from the previous session: mode, target type and lengths. */
function loadPrefs() {
  const fallback = {
    mode: 'walk',
    targetType: 'distance',
    km: { walk: 5, bike: 25 },
    minutes: { walk: 60, bike: 90 },
  }
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY))
    if (!saved) return fallback
    return {
      mode: saved.mode === 'bike' ? 'bike' : 'walk',
      targetType: saved.targetType === 'time' ? 'time' : 'distance',
      km: { ...fallback.km, ...clampPair(saved.km, fallback.km) },
      minutes: { ...fallback.minutes, ...clampPair(saved.minutes, fallback.minutes) },
    }
  } catch {
    return fallback
  }
}

/** Keep restored values inside the slider ranges, whatever is in storage. */
function clampPair(value, fallback) {
  if (!value || typeof value !== 'object') return fallback
  const out = {}
  for (const mode of ['walk', 'bike']) {
    const n = Number(value[mode])
    out[mode] = Number.isFinite(n) ? n : fallback[mode]
  }
  return out
}

function loadSavedStart() {
  try {
    const saved = JSON.parse(localStorage.getItem(START_KEY))
    if (Array.isArray(saved?.lngLat) && typeof saved?.label === 'string') {
      return saved
    }
  } catch {
    /* corrupt or absent — start fresh */
  }
  return null
}

const prefs = loadPrefs()
const savedRoute = loadSavedRoute()

export const store = reactive({
  mode: prefs.mode, // 'walk' | 'bike'
  start: loadSavedStart(), // { lngLat: [lng, lat], label: string }
  targetType: prefs.targetType, // 'distance' | 'time'
  km: prefs.km,
  minutes: prefs.minutes,
  nature: localStorage.getItem('meguri-nature') !== 'off',
  route: savedRoute?.route ?? null, // { geometry, distanceKm, durationSec }
  busy: false,
  error: '',
  flyTo: null, // { center, zoom, id } — MapView watches this
  sheetInset: 0, // px of viewport covered by the mobile sheet; MapView pads around it
  waypoints: loadWaypoints(), // [lng, lat][] the loop must pass through
  waypointMode: false, // map taps add waypoints instead of moving the start
  bearing: Math.random() * 360,
  clockwise: Math.random() < 0.5,
})

watch(
  () => store.route,
  (route) => {
    try {
      if (!route) localStorage.removeItem(ROUTE_KEY)
      else localStorage.setItem(ROUTE_KEY, JSON.stringify({ route }))
    } catch {
      /* quota or blocked — the route just won't survive a refresh */
    }
  },
)

watch(
  () => nav.active,
  (active) => {
    try {
      if (active) localStorage.setItem(NAV_KEY, '1')
      else localStorage.removeItem(NAV_KEY)
    } catch {
      /* ignore */
    }
  },
)

/**
 * Pick up where the last session left off: if navigation was running when the
 * page went away, start it again on the restored route.
 */
export function resumeSession() {
  if (!store.route) return
  if (localStorage.getItem(NAV_KEY) !== '1') return
  startNavigation(store.route, { mode: store.mode, nature: store.nature })
}

// Ranges can change between versions; pull restored values back in bounds.
for (const mode of ['walk', 'bike']) {
  const r = RANGES[mode]
  store.km[mode] = Math.min(Math.max(store.km[mode], r.km.min), r.km.max)
  store.minutes[mode] = Math.min(Math.max(store.minutes[mode], r.min.min), r.min.max)
}

watch(
  () => [store.mode, store.targetType, { ...store.km }, { ...store.minutes }],
  () => {
    try {
      localStorage.setItem(
        PREFS_KEY,
        JSON.stringify({
          mode: store.mode,
          targetType: store.targetType,
          km: store.km,
          minutes: store.minutes,
        }),
      )
    } catch {
      /* storage blocked — settings just won't carry over */
    }
  },
  { deep: true },
)

let flyId = 0
let abortController = null
let errorTimer = null

export function showError(message) {
  store.error = message
  clearTimeout(errorTimer)
  errorTimer = setTimeout(() => (store.error = ''), 4500)
}

export function setNature(value) {
  store.nature = value
  try {
    localStorage.setItem('meguri-nature', value ? 'on' : 'off')
  } catch {
    /* storage blocked — the preference just won't persist */
  }
}

export function targetKm() {
  if (store.targetType === 'distance') return store.km[store.mode]
  return Math.max(1, (store.minutes[store.mode] / 60) * SPEEDS[store.mode])
}

export function setStart(lngLat, label = null, { fly = false, zoom = 14 } = {}) {
  store.route = null
  store.start = {
    lngLat,
    label: label || `${lngLat[1].toFixed(4)}, ${lngLat[0].toFixed(4)}`,
  }
  // Stops near the new start stay useful; ones left behind in another part
  // of the world would only make every route attempt fail.
  const reach = Math.max(targetKm() * 2, 10)
  const kept = store.waypoints.filter((p) => distanceKm(p, lngLat) <= reach)
  if (kept.length !== store.waypoints.length) {
    store.waypoints = kept
    persistWaypoints()
  }
  if (fly) store.flyTo = { center: lngLat, zoom, id: ++flyId }
  persistStart()
  if (!label) {
    const current = store.start
    reverseGeocode(lngLat, locale.value).then((name) => {
      if (name && store.start === current) {
        store.start.label = name
        persistStart()
      }
    })
  }
}

function persistStart() {
  try {
    localStorage.setItem(START_KEY, JSON.stringify(store.start))
  } catch {
    /* storage full or blocked — not critical */
  }
}

function persistWaypoints() {
  try {
    localStorage.setItem(WAYPOINTS_KEY, JSON.stringify(store.waypoints))
  } catch {
    /* storage full or blocked — not critical */
  }
}

// A changed constraint invalidates the current loop, like moving the start.
export function addWaypoint(lngLat) {
  store.waypoints = [...store.waypoints, lngLat]
  store.route = null
  persistWaypoints()
}

export function moveWaypoint(index, lngLat) {
  store.waypoints = store.waypoints.map((p, i) => (i === index ? lngLat : p))
  store.route = null
  persistWaypoints()
}

export function removeWaypoint(index) {
  store.waypoints = store.waypoints.filter((_, i) => i !== index)
  store.route = null
  persistWaypoints()
}

export function clearWaypoints() {
  store.waypoints = []
  store.waypointMode = false
  store.route = null
  persistWaypoints()
}

export function locate() {
  if (!('geolocation' in navigator)) {
    showError('errNoGeo')
    return
  }
  store.busy = true
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      store.busy = false
      setStart([pos.coords.longitude, pos.coords.latitude], null, { fly: true })
    },
    () => {
      store.busy = false
      showError('errGeoFailed')
    },
    { enableHighAccuracy: true, timeout: 10000 },
  )
}

export async function generate({ shuffle = false } = {}) {
  if (!store.start) {
    showError('errNoStart')
    return
  }
  if (shuffle) {
    store.bearing = Math.random() * 360
    store.clockwise = Math.random() < 0.5
  }
  abortController?.abort()
  abortController = new AbortController()
  store.busy = true
  store.error = ''
  try {
    store.route = await generateLoop({
      start: store.start.lngLat,
      targetKm: targetKm(),
      profile: store.mode,
      nature: store.nature,
      bearing: store.bearing,
      clockwise: store.clockwise,
      waypoints: store.waypoints,
      signal: abortController.signal,
    })
  } catch (err) {
    if (err.name !== 'AbortError') {
      showError('errNoRoute')
    }
  } finally {
    store.busy = false
  }
}
