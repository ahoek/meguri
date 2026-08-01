import { distanceKm } from './geo.js'

// BRouter voice-hint command codes.
export const MANEUVER = {
  1: 'continue',
  2: 'left',
  3: 'slightLeft',
  4: 'sharpLeft',
  5: 'right',
  6: 'slightRight',
  7: 'sharpRight',
  8: 'keepLeft',
  9: 'keepRight',
  10: 'uturn',
  11: 'uturn',
  12: 'offRoute',
  13: 'roundabout',
  14: 'roundabout',
}

const GENTLE_ANGLE = 18 // degrees; below this a "slight" turn is just a curve

function isGentleBend(maneuver) {
  return (
    (maneuver.kind === 'slightLeft' || maneuver.kind === 'slightRight') &&
    Math.abs(maneuver.angle) < GENTLE_ANGLE
  )
}

const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI

/** Initial bearing in degrees from a to b. */
export function bearingBetween([lng1, lat1], [lng2, lat2]) {
  const φ1 = rad(lat1)
  const φ2 = rad(lat2)
  const Δλ = rad(lng2 - lng1)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/**
 * Precompute everything navigation needs from a generated route: cumulative
 * distance at each vertex and a maneuver list positioned along the line.
 */
export function prepareRoute(route) {
  const coords = route.geometry.coordinates
  const cumulative = new Array(coords.length)
  cumulative[0] = 0
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + distanceKm(coords[i - 1], coords[i])
  }
  const totalKm = cumulative[cumulative.length - 1]

  const maneuvers = (route.voicehints ?? [])
    .filter(([index, command]) => MANEUVER[command] && index < coords.length)
    .map(([index, command, exit, , angle]) => ({
      index,
      kind: MANEUVER[command],
      exit,
      angle: angle ?? 0,
      atKm: cumulative[index],
    }))
    // "continue" says nothing, and a barely-bent road isn't a turn worth
    // announcing — BRouter emits those for gentle curves.
    .filter((m) => m.kind !== 'continue' && m.kind !== 'offRoute')
    .filter((m) => !isGentleBend(m))
    // Two turns metres apart are one manoeuvre; keep the decisive one.
    .filter((m, i, all) => {
      const next = all[i + 1]
      return !next || (next.atKm - m.atKm) * 1000 > 25
    })

  return { coords, cumulative, totalKm, maneuvers }
}

/** Project a position onto the route. */
const RELOCATE_M = 60 // a worse match than this means the window was wrong
const TIE_M = 20 // candidates this close to the best are treated as equal

/**
 * Locate the very first fix of a session.
 *
 * On a loop the start and the finish are the same place, so a plain
 * nearest-point search can just as easily snap to the end of the line —
 * which reads as "you have already gone all the way round". Among all
 * near-equal candidates, take the earliest one.
 */
const AT_START_M = 90

export function locateInitial(prepared, position) {
  const { coords, cumulative } = prepared

  // Navigation starts where the loop starts. If we're anywhere near that
  // point, we are at the beginning of the route — not at the end of it,
  // which sits on exactly the same spot.
  if (distanceKm(position, coords[0]) * 1000 < AT_START_M) {
    return { index: 0, snapped: coords[0], alongKm: 0, offRouteM: 0 }
  }

  let best = null

  for (let i = 0; i < coords.length - 1; i++) {
    const { point, t } = projectOnSegment(coords[i], coords[i + 1], position)
    const d = distanceKm(position, point) * 1000
    if (!best || d < best.d - TIE_M) {
      best = {
        d,
        index: i,
        snapped: point,
        alongKm: cumulative[i] + t * (cumulative[i + 1] - cumulative[i]),
      }
    }
  }

  return {
    index: best.index,
    snapped: best.snapped,
    alongKm: best.alongKm,
    offRouteM: best.d,
  }
}

export function locateOnRoute(prepared, position, fromIndex = 0) {
  const { coords } = prepared
  // Search a window ahead of where we were, so a loop passing near itself
  // can't teleport progress onto the wrong lap.
  const windowed = scan(
    prepared,
    position,
    Math.max(0, fromIndex - 12),
    Math.min(coords.length - 1, fromIndex + 220),
  )
  // If nothing nearby fits — the walker backtracked, GPS jumped, or
  // navigation resumed elsewhere — fall back to searching the whole route.
  if (windowed.offRouteM <= RELOCATE_M) return windowed
  const full = scan(prepared, position, 0, coords.length - 1)
  return full.offRouteM < windowed.offRouteM ? full : windowed
}

function scan(prepared, position, start, end) {
  const { coords, cumulative } = prepared
  let bestDist = Infinity
  let bestIndex = start
  let bestAlong = cumulative[start]
  let bestPoint = coords[start]

  for (let i = start; i < end; i++) {
    const { point, t } = projectOnSegment(coords[i], coords[i + 1], position)
    const d = distanceKm(position, point)
    if (d < bestDist) {
      bestDist = d
      bestIndex = i
      bestPoint = point
      bestAlong = cumulative[i] + t * (cumulative[i + 1] - cumulative[i])
    }
  }

  return {
    index: bestIndex,
    snapped: bestPoint,
    alongKm: bestAlong,
    offRouteM: bestDist * 1000,
  }
}

/** Closest point on segment a→b to p, in flat local coordinates. */
function projectOnSegment(a, b, p) {
  // Scale longitude so a degree of each axis covers a similar distance.
  const k = Math.cos(rad(a[1])) || 1e-6
  const ax = a[0] * k
  const ay = a[1]
  const bx = b[0] * k
  const by = b[1]
  const px = p[0] * k
  const py = p[1]

  const dx = bx - ax
  const dy = by - ay
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return { point: a, t: 0 }

  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return {
    point: [(ax + t * dx) / k, ay + t * dy],
    t,
  }
}

/**
 * Which way the route runs at `index`, averaged over a short span ahead so a
 * single kinked vertex doesn't spin the arrow.
 */
export function routeBearingAt(prepared, index) {
  const { coords } = prepared
  const from = coords[Math.max(0, Math.min(index, coords.length - 2))]
  const to = coords[Math.min(index + 4, coords.length - 1)]
  return bearingBetween(from, to)
}

/**
 * The point `km` along the route, interpolated within its segment. Used to
 * carry the display forward between GPS fixes.
 */
export function positionAtKm(prepared, km) {
  const { coords, cumulative, totalKm } = prepared
  const target = Math.max(0, Math.min(km, totalKm))

  let lo = 0
  let hi = cumulative.length - 1
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= target) lo = mid
    else hi = mid
  }

  const span = cumulative[hi] - cumulative[lo]
  const f = span > 0 ? (target - cumulative[lo]) / span : 0
  const a = coords[lo]
  const b = coords[hi]
  return {
    position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
    index: lo,
    bearing: routeBearingAt(prepared, lo),
  }
}

/** The next maneuver at or after `alongKm`, with its distance in metres. */
export function nextManeuver(prepared, alongKm) {
  const upcoming = prepared.maneuvers.find((m) => m.atKm > alongKm - 0.005)
  if (!upcoming) return null
  // The 5 m grace above can put the turn just behind us; never show negatives.
  return {
    ...upcoming,
    distanceM: Math.max(0, (upcoming.atKm - alongKm) * 1000),
  }
}

/** Slice the route ahead of the current position, for drawing. */
export function remainingLine(prepared, index, snapped) {
  return [snapped, ...prepared.coords.slice(index + 1)]
}

export function traveledLine(prepared, index, snapped) {
  return [...prepared.coords.slice(0, index + 1), snapped]
}
