import { distanceKm } from './geo'
import type { LngLat } from './geo'
import type { Route } from './route'

export interface Maneuver {
  index: number
  kind: string
  exit: number
  angle: number
  atKm: number
}

export interface PreparedRoute {
  coords: LngLat[]
  cumulative: number[]
  totalKm: number
  maneuvers: Maneuver[]
}

interface RouteFix {
  index: number
  snapped: LngLat
  alongKm: number
  offRouteM: number
}

// BRouter voice-hint command codes.
export const MANEUVER: Record<number, string> = {
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

function isGentleBend(maneuver: Maneuver) {
  return (
    (maneuver.kind === 'slightLeft' || maneuver.kind === 'slightRight') &&
    Math.abs(maneuver.angle) < GENTLE_ANGLE
  )
}

const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/**
 * Signed degrees from one bearing to another, taking the short way round.
 * Easing towards a raw difference spins almost the whole way back whenever a
 * turn crosses north.
 */
export function shortestTurn(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180
}

/** Initial bearing in degrees from a to b. */
export function bearingBetween([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
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
export function prepareRoute(route: Route): PreparedRoute {
  const coords = route.geometry.coordinates
  const cumulative: number[] = new Array(coords.length)
  cumulative[0] = 0
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + distanceKm(coords[i - 1], coords[i])
  }
  const totalKm = cumulative[cumulative.length - 1]

  const maneuvers: Maneuver[] = (route.voicehints ?? [])
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
// A relocation has to beat the window decisively, not merely tie with it. On a
// loop the last leg runs back over the first, so "a few metres closer" there is
// not evidence of a completed lap — it is the same street measured twice.
const RELOCATE_MARGIN_M = 25
const TIE_M = 20 // candidates this close to the best are treated as equal

/**
 * Locate the very first fix of a session.
 *
 * On a loop the start and the finish are the same place, so a plain
 * nearest-point search can just as easily snap to the end of the line —
 * which reads as "you have already gone all the way round". Among all
 * near-equal candidates, take the earliest one.
 *
 * A vague fix widens that radius by its own admitted error. The first reading
 * a phone offers is often a coarse network fix hundreds of metres out while
 * the GPS is still warming up, and one that cannot rule out the start point
 * must not be used to rule it out.
 */
export const AT_START_M = 90

export function locateInitial(
  prepared: PreparedRoute,
  position: LngLat,
  accuracy: number | null = null,
): RouteFix {
  const { coords, cumulative } = prepared

  // Navigation starts where the loop starts. If we're anywhere near that
  // point, we are at the beginning of the route — not at the end of it,
  // which sits on exactly the same spot.
  if (distanceKm(position, coords[0]) * 1000 < AT_START_M + Math.max(accuracy ?? 0, 0)) {
    return { index: 0, snapped: coords[0], alongKm: 0, offRouteM: 0 }
  }

  let best: { d: number; index: number; snapped: LngLat; alongKm: number } | null = null

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
    index: best!.index,
    snapped: best!.snapped,
    alongKm: best!.alongKm,
    offRouteM: best!.d,
  }
}

// How far around the last known position the tracking window reaches. Measured
// in route distance, not vertices: BRouter's spacing runs from a couple of
// metres on a mapped corner to hundreds on a straight, so a fixed vertex count
// is a window of unknown size — on a short loop it spanned the whole thing,
// which let a fix at the start match the finish and read as a completed lap.
const WINDOW_BACK_KM = 0.05
const WINDOW_AHEAD_KM = 1

/** The last vertex at or before `km`. */
function indexAtKm(cumulative: number[], km: number): number {
  let lo = 0
  let hi = cumulative.length - 1
  if (km <= 0) return 0
  if (km >= cumulative[hi]) return hi
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1
    if (cumulative[mid] <= km) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Project a position onto the route, searching around where we last were.
 *
 * `relocate` allows the search to give up on that window and rescan the whole
 * route — needed when the walker backtracks, the GPS jumps, or the phone spent
 * a while in a pocket. It is refused before we have seen the walker leave the
 * start, because at that point the only far-away match a rescan can find is
 * the finish, sitting on the very spot they are standing on.
 */
export function locateOnRoute(
  prepared: PreparedRoute,
  position: LngLat,
  fromIndex = 0,
  { relocate = true } = {},
): RouteFix {
  const { coords, cumulative } = prepared
  const at = cumulative[Math.min(Math.max(fromIndex, 0), cumulative.length - 1)] ?? 0
  const windowed = scan(
    prepared,
    position,
    indexAtKm(cumulative, at - WINDOW_BACK_KM),
    Math.min(coords.length - 1, indexAtKm(cumulative, at + WINDOW_AHEAD_KM) + 1),
    at,
  )
  if (!relocate || windowed.offRouteM <= RELOCATE_M) return windowed
  const full = scan(prepared, position, 0, coords.length - 1, at)
  return full.offRouteM < windowed.offRouteM - RELOCATE_MARGIN_M ? full : windowed
}

/**
 * How close two candidates have to be before the route decides between them
 * rather than the tape measure.
 *
 * On a path walked in both directions, standing anywhere puts you at two
 * places along the route at once — a hundred metres out and, on the same
 * paving stone, six hundred metres on the way home. Both fit the reading
 * perfectly, and which one comes out nearest is then settled by whether the
 * router happened to lay its vertices down in quite the same spots on the way
 * back. It does not, so the answer was a coin toss, and losing it meant being
 * told you were on the way home before you had reached the turnaround.
 *
 * Ten metres is wider than that difference will ever be and narrower than any
 * real choice between two different pieces of road.
 */
const SAME_GROUND_M = 10
// And how far apart two readings have to be along the route before they count
// as answers to different questions rather than the same one measured twice.
const ELSEWHERE_KM = 0.05

/**
 * The closest point on a stretch of the route — and where two are equally
 * close, the one nearest to where we already thought we were.
 *
 * Continuity is the only evidence there is here. It is also the right evidence
 * in both directions: on the way out the outbound reading is the near one, and
 * on the way home it is the homeward reading, without either being singled out.
 */
function scan(
  prepared: PreparedRoute,
  position: LngLat,
  start: number,
  end: number,
  anchorKm?: number,
): RouteFix {
  const { coords, cumulative } = prepared
  const candidates: { d: number; index: number; point: LngLat; along: number }[] = []
  let nearest = Infinity

  for (let i = start; i < end; i++) {
    const { point, t } = projectOnSegment(coords[i], coords[i + 1], position)
    const d = distanceKm(position, point)
    nearest = Math.min(nearest, d)
    candidates.push({
      d,
      index: i,
      point,
      along: cumulative[i] + t * (cumulative[i + 1] - cumulative[i]),
    })
  }

  if (!candidates.length) {
    return {
      index: start,
      snapped: coords[start],
      alongKm: cumulative[start],
      offRouteM: Infinity,
    }
  }

  // The plain answer first: the closest point on the line.
  let best = candidates[0]
  for (const c of candidates) if (c.d < best.d) best = c
  if (anchorKm == null) {
    return {
      index: best.index,
      snapped: best.point,
      alongKm: best.along,
      offRouteM: best.d * 1000,
    }
  }

  // Then the question continuity is allowed to answer: is there a rival that
  // fits the ground just as well but sits somewhere else entirely along the
  // route? Only somewhere *else* — a candidate a few metres up the same
  // stretch is not a second opinion about which leg you are on, and letting it
  // win would drag the projection backwards along the road for nothing.
  const limit = nearest + SAME_GROUND_M / 1000
  let rival = best
  for (const c of candidates) {
    if (c.d > limit) continue
    if (Math.abs(c.along - best.along) < ELSEWHERE_KM) continue
    if (Math.abs(c.along - anchorKm) < Math.abs(rival.along - anchorKm)) rival = c
  }
  if (Math.abs(rival.along - anchorKm) < Math.abs(best.along - anchorKm)) best = rival

  return {
    index: best.index,
    snapped: best.point,
    alongKm: best.along,
    offRouteM: best.d * 1000,
  }
}

/** Closest point on segment a→b to p, in flat local coordinates. */
function projectOnSegment(
  a: LngLat,
  b: LngLat,
  p: LngLat,
): { point: LngLat; t: number } {
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
 * The point `km` along the route, interpolated within its segment. Used to
 * carry the display forward between GPS fixes.
 */
export function positionAtKm(
  prepared: PreparedRoute,
  km: number,
): { position: LngLat; index: number } {
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
  // No bearing here: direction comes from bearingAlong(), which is built on
  // this function and would recurse.
  return {
    position: [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f],
    index: lo,
  }
}

/**
 * The direction of the road you are actually on: the polyline segment under
 * your feet, extended just far enough to be stable on finely mapped ways.
 *
 * Distinct from bearingAlong(), which averages over a window and therefore
 * straddles both legs of a corner — giving a direction that matches neither.
 */
export function segmentBearingAt(
  prepared: PreparedRoute,
  index: number,
  from: LngLat | null = null,
): number {
  const { coords, cumulative } = prepared
  const start = Math.max(0, Math.min(index, coords.length - 2))
  const origin = from ?? coords[start]

  // Step forward until the segment is long enough to have a clear direction.
  const MIN_SPAN_KM = 0.012
  let end = start + 1
  while (
    end < coords.length - 1 &&
    cumulative[end] - cumulative[start] < MIN_SPAN_KM
  ) {
    end += 1
  }
  return bearingBetween(origin, coords[end])
}

// Look this far up the road to decide "which way am I heading". Measured in
// distance, not vertices: vertex spacing varies wildly, so a fixed count
// swings the arrow on densely mapped corners and lags on long straights.
const HEADING_LOOKAHEAD_KM = 0.035

/** Which way the route runs at `index`. */
export function routeBearingAt(prepared: PreparedRoute, index: number): number {
  return bearingAlong(prepared, prepared.cumulative[index] ?? 0)
}

/**
 * Which way the route runs at a distance along it.
 *
 * `lookaheadKm` decides how far up the road to aim. The arrow uses a short
 * one so it turns into a corner as you reach it; the camera uses a longer one
 * so it holds the general direction and doesn't lurch at every bend.
 */
export function bearingAlong(
  prepared: PreparedRoute,
  km: number,
  lookaheadKm = HEADING_LOOKAHEAD_KM,
): number {
  const here = positionAtKm(prepared, km)
  const ahead = positionAtKm(prepared, km + lookaheadKm)
  // At the very end there's nothing ahead to aim at; keep the last direction.
  if (here.position[0] === ahead.position[0] && here.position[1] === ahead.position[1]) {
    const back = positionAtKm(prepared, Math.max(0, km - lookaheadKm))
    return bearingBetween(back.position, here.position)
  }
  return bearingBetween(here.position, ahead.position)
}

/** The next maneuver at or after `alongKm`, with its distance in metres. */
export function nextManeuver(
  prepared: PreparedRoute,
  alongKm: number,
): (Maneuver & { distanceM: number }) | null {
  const upcoming = prepared.maneuvers.find((m) => m.atKm > alongKm - 0.005)
  if (!upcoming) return null
  // The 5 m grace above can put the turn just behind us; never show negatives.
  return {
    ...upcoming,
    distanceM: Math.max(0, (upcoming.atKm - alongKm) * 1000),
  }
}

/**
 * The manoeuvre following the one at `atKm`, and the gap between the two.
 *
 * "Right, then immediately left" is a different instruction from "right", and
 * a walker who reads the screen at the fork and puts the phone away has no
 * second chance to find that out. So the pair travels together.
 */
export function maneuverAfter(
  prepared: PreparedRoute,
  atKm: number,
): (Maneuver & { gapM: number }) | null {
  const following = prepared.maneuvers.find((m) => m.atKm > atKm + 0.001)
  if (!following) return null
  return { ...following, gapM: Math.max(0, (following.atKm - atKm) * 1000) }
}

/**
 * Cut a way-back path where it first reaches the route.
 *
 * BRouter is asked to route to a point some way ahead along the loop, and often
 * enough the cheapest path there rejoins the loop earlier and then simply
 * follows it. Drawn whole, the last stretch is an orange dashed line lying
 * directly on top of the route it is supposedly leading you back to — which
 * reads as two different instructions for the same piece of road.
 *
 * The path's job ends the moment you are back on the route, so it ends there
 * too. Distance is recomputed for the part that survives, because that figure
 * is on the banner and "back to the route: 300 m" must not be counting metres
 * spent already on it.
 */
export function trimToRoute(
  prepared: PreparedRoute,
  path: LngLat[],
  fromIndex: number,
  meetsM: number,
): { coordinates: LngLat[]; distanceKm: number } {
  // From the second vertex on: the first is where you are standing, and if that
  // already counts as "on the route" there is nothing to draw anyway.
  let end = path.length - 1
  for (let i = 1; i < path.length; i++) {
    const { offRouteM } = locateOnRoute(prepared, path[i], fromIndex, {
      relocate: false,
    })
    if (offRouteM <= meetsM) {
      end = i
      break
    }
  }

  const coordinates = path.slice(0, end + 1)
  let total = 0
  for (let i = 1; i < coordinates.length; i++) {
    total += distanceKm(coordinates[i - 1], coordinates[i])
  }
  return { coordinates, distanceKm: total }
}

/** Slice the route ahead of the current position, for drawing. */
export function remainingLine(
  prepared: PreparedRoute,
  index: number,
  snapped: LngLat,
): LngLat[] {
  return [snapped, ...prepared.coords.slice(index + 1)]
}

export function traveledLine(
  prepared: PreparedRoute,
  index: number,
  snapped: LngLat,
): LngLat[] {
  return [...prepared.coords.slice(0, index + 1), snapped]
}
