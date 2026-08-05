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

const pointKey = (p: LngLat) => `${p[0]},${p[1]}`

/** Metres from `point` to the nearest vertex of `coords`. */
function nearestVertexM(coords: LngLat[], point: LngLat): number {
  let best = Infinity
  for (const c of coords) {
    const d = distanceKm(c, point)
    if (d < best) best = d
  }
  return best * 1000
}

/** The vertex of `coords` closest to `point` — where the router actually got. */
function nearestVertex(coords: LngLat[], point: LngLat): LngLat {
  let best = coords[0]
  let bestKm = Infinity
  for (const c of coords) {
    const d = distanceKm(c, point)
    if (d < bestKm) {
      bestKm = d
      best = c
    }
  }
  return best
}

/**
 * Remove out-and-back spurs (A → T → A dead-end tips). The loop stays intact
 * and endpoints are preserved — a shorter route beats backtracking.
 *
 * `keep` holds coordinates that must survive whatever it costs in doubled
 * road. A stop the rider asked for is often down a dead end, a pier or a
 * park path, and reaching it means coming back out the same way; trimming
 * that leg left the loop passing a hundred metres from the pin.
 *
 * Returns the trimmed points plus `origin`, mapping each surviving point back
 * to its index in the input, so turn instructions can be re-indexed.
 */
function trimSpurs(coords: LngLat[], keep: ReadonlySet<string> = new Set()) {
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
      // U-turn tip: drop it, the incoming point already follows. Protection
      // is by coordinate, so dropping a duplicate above can't quietly strand
      // a stop by losing the index that vouched for it.
      if (
        out.length > 1 &&
        samePoint(out[out.length - 2], pts[i]) &&
        !keep.has(pointKey(prev))
      ) {
        out.pop()
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

/**
 * Is there a stretch the route walks twice, long enough to be worth drawing as
 * two lanes?
 *
 * The longest unbroken doubled run, not the total and not a share of the
 * route: a hundred metres walked in both directions is exactly as confusing on
 * a two-kilometre stroll as on a twenty-kilometre ride, and a loop that clips
 * its own path at four separate junctions has no there-and-back leg at all,
 * however the four add up. The case this exists for is the lollipop — out
 * along a path and back down the same one, which is the shape the start of a
 * loop most often takes.
 *
 * Fifty metres is about the shortest doubled stretch worth the trouble; below
 * that it is a junction touching itself, and a metre and a half of offset buys
 * nothing.
 */
const DOUBLED_BACK_M = 50

export function doublesBack(coords: LngLat[]) {
  const seen = new Set<string>()
  const key = (p: LngLat) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`
  let run = 0
  let longest = 0
  for (let i = 1; i < coords.length; i++) {
    const edge = [key(coords[i - 1]), key(coords[i])].sort().join('|')
    if (seen.has(edge)) {
      run += distanceKm(coords[i - 1], coords[i]) * 1000
      longest = Math.max(longest, run)
    } else {
      seen.add(edge)
      run = 0
    }
  }
  return longest >= DOUBLED_BACK_M
}

// How much closer the untrimmed route got to a stop before we count the stop
// as lost. Rounding and a dropped duplicate vertex are worth a few metres.
const TRIM_SLACK_M = 25

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

    // What the router managed for each stop, before anything is taken away.
    const routed = route.geometry.coordinates
    const reachedM = waypoints.map((w) => nearestVertexM(routed, w))
    const keep = new Set(waypoints.map((w) => pointKey(nearestVertex(routed, w))))

    const { points: trimmed, origin } = trimSpurs(routed, keep)
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

    // Doubling back to reach a stop is the price of asking for it, so it is
    // not held against the loop — otherwise the search spends its attempts
    // hunting a shape with no backtracking, which for a pin down a dead end
    // does not exist. Measured on the route with every spur removed, which
    // is what the ride would look like without the stops.
    const bare = waypoints.length ? trimSpurs(routed).points : route.geometry.coordinates
    const overlap = overlapFraction(bare)

    // Reaching the stops is not negotiable. Compared against what the router
    // itself achieved, not an absolute distance: a pin dropped in the middle
    // of a field is as reached as it will ever be once the loop is on the
    // nearest path.
    const missed = waypoints.filter(
      (w, i) => nearestVertexM(route.geometry.coordinates, w) > reachedM[i] + TRIM_SLACK_M,
    ).length

    // Riding the same road twice annoys more than a kilometre missing, so
    // overlap dominates the score — but a missed stop outranks them both.
    const score = missed * 100 + distErr + overlap * 4

    if (score < bestScore) {
      best = route
      bestScore = score
    }
    if (!missed && distErr < 0.06 && overlap < 0.08) break
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
