import { loopViaPoints, loopViaWithWaypoints, distanceKm } from './geo.js'
import bikeNatureProfile from '../profiles/bike-nature.brf?raw'
import walkNatureProfile from '../profiles/walk-nature.brf?raw'

// BRouter (brouter.de, free) instead of OSRM: its profiles actively prefer
// bike paths / footpaths, avoid busy roads and penalize traffic lights.
const BROUTER = 'https://brouter.de/brouter'
const PROFILE = { walk: 'hiking-beta', bike: 'trekking' }

// Nature variants: the stock profiles with BRouter's forest/town/noise/traffic
// estimates switched on, so green detours beat the direct route through town.
// They must be registered with the server, which hands back a temporary id.
const NATURE_SOURCE = { walk: walkNatureProfile, bike: bikeNatureProfile }
const natureIds = {}

// Bump whenever a .brf changes, so clients stop reusing the id of the
// profile they registered from the previous version.
const PROFILE_VERSION = 3

function cacheKey(mode) {
  return `meguri-profile-${mode}-v${PROFILE_VERSION}`
}

async function registerNatureProfile(mode, signal) {
  const res = await fetch(`${BROUTER}/profile`, {
    method: 'POST',
    body: NATURE_SOURCE[mode],
    signal,
  })
  if (!res.ok) throw new Error('Profile upload failed')
  const { profileid } = await res.json()
  if (!profileid) throw new Error('Profile upload failed')
  natureIds[mode] = profileid
  try {
    localStorage.setItem(cacheKey(mode), profileid)
  } catch {
    /* storage blocked — the in-memory id still works this session */
  }
  return profileid
}

async function natureProfileId(mode, signal) {
  if (natureIds[mode]) return natureIds[mode]
  const cached = localStorage.getItem(cacheKey(mode))
  if (cached) {
    natureIds[mode] = cached
    return cached
  }
  return registerNatureProfile(mode, signal)
}

async function requestRoute(points, profileName, signal) {
  const lonlats = points
    .map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`)
    .join('|')
  const url =
    `${BROUTER}?lonlats=${lonlats}&profile=${profileName}` +
    `&alternativeidx=0&format=geojson&timode=2`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Routing failed (${res.status})`)
  const json = await res.json()
  const feature = json.features?.[0]
  if (!feature) throw new Error('No route found')
  return {
    geometry: feature.geometry, // LineString, coordinates are [lng, lat, ele]
    distanceKm: Number(feature.properties['track-length']) / 1000,
    durationSec: Number(feature.properties['total-time']),
    // [pointIndex, command, exitNumber, distanceToNext, angle] per maneuver
    voicehints: feature.properties.voicehints ?? [],
  }
}

const reRegistered = {}

async function fetchRoute(points, mode, nature, signal) {
  if (!nature) return requestRoute(points, PROFILE[mode], signal)

  const id = await natureProfileId(mode, signal)
  try {
    return await requestRoute(points, id, signal)
  } catch (err) {
    if (err.name === 'AbortError' || reRegistered[mode]) throw err
    // The server drops custom profiles after a while — register again once,
    // then let any further failure surface so the caller can try new terrain.
    reRegistered[mode] = true
    const freshId = await registerNatureProfile(mode, signal)
    return requestRoute(points, freshId, signal)
  }
}

/** Route directly between waypoints — used to guide back after a wrong turn. */
export async function routeBetween({ points, profile, nature = true, signal }) {
  return fetchRoute(points, profile, nature, signal)
}

const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1]

/**
 * Remove out-and-back spurs (A → T → A dead-end tips). The loop stays intact
 * and endpoints are preserved — a shorter route beats backtracking.
 *
 * Returns the trimmed points plus `origin`, mapping each surviving point back
 * to its index in the input, so turn instructions can be re-indexed.
 */
function trimSpurs(coords) {
  let pts = coords
  let origin = coords.map((_, i) => i)
  let changed = true
  while (changed) {
    changed = false
    const out = [pts[0]]
    const outOrigin = [origin[0]]
    for (let i = 1; i < pts.length; i++) {
      const prev = out[out.length - 1]
      if (samePoint(pts[i], prev)) {
        changed = true
        continue
      }
      if (out.length > 1 && samePoint(out[out.length - 2], pts[i])) {
        out.pop() // U-turn tip: drop it, the incoming point already follows
        outOrigin.pop()
        changed = true
        continue
      }
      out.push(pts[i])
      outOrigin.push(origin[i])
    }
    pts = out
    origin = outOrigin
  }
  return { points: pts, origin }
}

/** Fraction of the track that runs over the same street twice. */
function overlapFraction(coords) {
  const seen = new Set()
  let total = 0
  let repeated = 0
  const key = (p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`
  for (let i = 1; i < coords.length; i++) {
    const len = distanceKm(coords[i - 1], coords[i])
    total += len
    const edge = [key(coords[i - 1]), key(coords[i])].sort().join('|')
    if (seen.has(edge)) repeated += len
    else seen.add(edge)
  }
  return total ? repeated / total : 0
}

function polylineKm(coords) {
  let total = 0
  for (let i = 1; i < coords.length; i++) {
    total += distanceKm(coords[i - 1], coords[i])
  }
  return total
}

/**
 * Generate a round trip close to `targetKm`, starting and ending at `start`.
 * Routes via points on a circle and iteratively rescales the circle until the
 * routed length matches the target. Candidates are scored on both length
 * accuracy and street overlap, so a slightly-off loop with no backtracking
 * wins over an exact one that doubles back on itself.
 *
 * User `waypoints` pin the loop: it always routes through them (in angular
 * order around their centroid), and only the generated filler points scale
 * with the length fitting. Far-apart waypoints can demand more distance than
 * the target asks for — the loop then simply becomes as short as they allow.
 */
export async function generateLoop({
  start,
  targetKm,
  profile,
  nature = true,
  bearing,
  clockwise,
  waypoints = [],
  signal,
}) {
  let radius = Math.max(0.12, targetKm / (2 * Math.PI))
  let currentBearing = bearing
  let viaCount = 4
  let best = null
  let bestScore = Infinity
  let lastError = null

  for (let attempt = 0; attempt < 7; attempt++) {
    const via = waypoints.length
      ? loopViaWithWaypoints(start, waypoints, radius, currentBearing, clockwise, viaCount)
      : loopViaPoints(start, radius, currentBearing, clockwise, viaCount)

    let route
    try {
      route = await fetchRoute([start, ...via, start], profile, nature, signal)
    } catch (err) {
      if (err.name === 'AbortError') throw err
      // A via-point landed somewhere unroutable (water, private land).
      // Keep whatever we already have and swing the circle elsewhere.
      lastError = err
      currentBearing += 61
      radius *= 0.85
      continue
    }

    const { points: trimmed, origin } = trimSpurs(route.geometry.coordinates)
    if (trimmed.length < route.geometry.coordinates.length) {
      const newKm = polylineKm(trimmed)
      route.durationSec *= newKm / route.distanceKm
      route.distanceKm = newKm
      route.geometry = { ...route.geometry, coordinates: trimmed }
      // Voice hints index into the untrimmed point list — re-index them and
      // drop any whose point was on a spur we removed.
      const newIndexOf = new Map(origin.map((old, next) => [old, next]))
      route.voicehints = route.voicehints
        .filter((h) => newIndexOf.has(h[0]))
        .map((h) => [newIndexOf.get(h[0]), ...h.slice(1)])
    }

    const distErr = Math.abs(route.distanceKm - targetKm) / targetKm
    const overlap = overlapFraction(route.geometry.coordinates)
    // Riding the same road twice annoys more than a kilometre missing, so
    // overlap dominates the score.
    const score = distErr + overlap * 4

    if (score < bestScore) {
      best = route
      bestScore = score
    }
    if (distErr < 0.06 && overlap < 0.08) break
    // With nothing left to remove, over-target means the waypoints themselves
    // demand the distance — a clean loop through them is as good as it gets.
    if (
      waypoints.length &&
      viaCount === 0 &&
      route.distanceKm >= targetKm &&
      overlap < 0.08
    ) {
      break
    }

    const overLength = waypoints.length && route.distanceKm > targetKm * 1.1

    if (overlap > 0.08) {
      // Doubling back: swing towards new terrain, and pin the loop to its
      // circle with an extra via point so two legs can't collapse onto the
      // same road between them — unless the waypoints already make the loop
      // too long, where extra filler only adds distance.
      currentBearing += 47
      if (!overLength) viaCount = Math.min(viaCount + 1, 7)
    }
    if (overLength && viaCount > 0) {
      viaCount -= 1 // shed filler before shrinking the circle further
    }
    const ratio = route.distanceKm / targetKm
    radius = Math.min(Math.max(radius / ratio, radius * 0.45), radius * 2.2)
  }

  if (!best) throw lastError ?? new Error('No route found')
  return best
}
