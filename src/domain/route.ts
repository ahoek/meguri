import { loopViaPoints, loopViaWithWaypoints, distanceKm } from './geo'
import type { LngLat } from './geo'

// [pointIndex, command, exitNumber, distanceToNext, angle] per maneuver.
export type VoiceHint = number[]

export interface Route {
  geometry: { type: string; coordinates: LngLat[] }
  distanceKm: number
  durationSec: number
  voicehints: VoiceHint[]
}

export type Profile = 'walk' | 'bike'

/**
 * Routes through the given points and returns the resulting track. The
 * domain never talks to a router itself — the caller injects one (BRouter
 * in production, plain stubs in tests).
 */
export type RouteThrough = (points: LngLat[]) => Promise<Route>

const samePoint = (a: LngLat, b: LngLat) => a[0] === b[0] && a[1] === b[1]

/**
 * Remove out-and-back spurs (A → T → A dead-end tips). The loop stays intact
 * and endpoints are preserved — a shorter route beats backtracking.
 *
 * Returns the trimmed points plus `origin`, mapping each surviving point back
 * to its index in the input, so turn instructions can be re-indexed.
 */
function trimSpurs(coords: LngLat[]) {
  let pts = coords
  let origin = coords.map((_, i) => i)
  let changed = true
  while (changed) {
    changed = false
    const out: LngLat[] = [pts[0]]
    const outOrigin: number[] = [origin[0]]
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
function overlapFraction(coords: LngLat[]) {
  const seen = new Set<string>()
  let total = 0
  let repeated = 0
  const key = (p: LngLat) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`
  for (let i = 1; i < coords.length; i++) {
    const len = distanceKm(coords[i - 1], coords[i])
    total += len
    const edge = [key(coords[i - 1]), key(coords[i])].sort().join('|')
    if (seen.has(edge)) repeated += len
    else seen.add(edge)
  }
  return total ? repeated / total : 0
}

function polylineKm(coords: LngLat[]) {
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
  bearing,
  clockwise,
  waypoints = [],
  routeThrough,
}: {
  start: LngLat
  targetKm: number
  bearing: number
  clockwise: boolean
  waypoints?: LngLat[]
  routeThrough: RouteThrough
}): Promise<Route> {
  let radius = Math.max(0.12, targetKm / (2 * Math.PI))
  let currentBearing = bearing
  let viaCount = 4
  let best: Route | null = null
  let bestScore = Infinity
  let lastError: unknown = null

  for (let attempt = 0; attempt < 7; attempt++) {
    const via = waypoints.length
      ? loopViaWithWaypoints(start, waypoints, radius, currentBearing, clockwise, viaCount)
      : loopViaPoints(start, radius, currentBearing, clockwise, viaCount)

    let route: Route
    try {
      route = await routeThrough([start, ...via, start])
    } catch (err) {
      if ((err as Error).name === 'AbortError') throw err
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
        .map((h) => [newIndexOf.get(h[0])!, ...h.slice(1)])
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

  if (!best) throw (lastError as Error) ?? new Error('No route found')
  return best
}
