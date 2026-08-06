import { loopViaPoints, loopViaWithWaypoints, distanceKm } from './geo'
import type { LngLat } from './geo'

// [pointIndex, command, exitNumber, distanceToNext, angle] per maneuver.
export type VoiceHint = number[]

export interface Route {
  geometry: { type: string; coordinates: LngLat[] }
  distanceKm: number
  durationSec: number
  voicehints: VoiceHint[]
  /**
   * Share of the route's length running through woods, parks or open country,
   * from 0 to 1. Null when the router did not say — the stock profiles do not
   * ask for the land-cover estimate, so nothing is known and nothing is scored.
   */
  greenFraction?: number | null
  /**
   * Which stretches that green is: `greenMask[i]` covers the segment from
   * vertex `i` to `i + 1` of the geometry. Null on the same terms as the
   * fraction, and also when the router's message table could not be aligned
   * with the geometry — a mask that might be shifted by one street is worse
   * than none.
   */
  greenMask?: boolean[] | null
}

export type Profile = 'walk' | 'bike'

/**
 * What greenness is worth when choosing between candidate loops.
 *
 * Deliberately smaller than a length error the app would otherwise reject: the
 * promise is a loop of the length you asked for, and no amount of woodland buys
 * a route half a kilometre short. But comfortably bigger than the difference
 * between two loops that both land inside the length tolerance, which is exactly
 * the choice this exists to settle.
 */
const GREEN_WEIGHT = 0.35

/**
 * The length promise, enforced.
 *
 * Inside the tolerance, distance error is a tie-breaker like any other. Past
 * it, the error is charged steeply — because the linear term alone let green
 * outbid length: measured on a 4 km ask, an 80%-green loop of 3.2 km beat
 * greyer full-length candidates, its 0.2 length penalty cheaper than the 0.35
 * the greenness earned. However green the walk, it is not the walk that was
 * asked for. Ten percent, not the 6% that stops the search early: candidates
 * between the two are imperfect but honest answers, and somewhere has to
 * absorb the granularity of real street blocks.
 */
const LENGTH_TOLERANCE = 0.1
const LENGTH_EXCESS_WEIGHT = 10

/**
 * What doubling back costs, by the ground it happens on.
 *
 * Walking the same street twice annoys more than a kilometre missing, so
 * overlap dominates the score. But charging every repeated metre alike is the
 * measured reason green loops kept losing: a park has fewer paths than a
 * street grid, so the route that actually goes through the park doubles back
 * a little more, and at ×4 a 10% overlap costs more than 100% greenness earns.
 * The park loop loses on the very thing that makes it green.
 *
 * So repeated ground through green is charged less — not nothing. Walking the
 * same woodland path twice is still walking the same path twice, and a green
 * loop that manages not to must still beat one that doesn't. At ×1.5 a 10%
 * green overlap costs 0.15 against the 0.35 the greenness earns: the park
 * route wins, and among park routes the cleaner one wins.
 */
const OVERLAP_WEIGHT = 4
const GREEN_OVERLAP_WEIGHT = 1.5

/**
 * A route through a building is a route through wrong data.
 *
 * OSM sometimes knows a way that is not there — a passage mapped through a
 * block that was rebuilt. The router cannot tell, but the map's own building
 * footprints can, so a candidate that threads one loses to any candidate that
 * does not: below a missed stop, above everything else — including a badly
 * missed length, since a walk that is too long is still a walk, and one sent
 * through a wall is not. A few metres are forgiven — footprints are tile
 * geometry, and a route hugging a facade grazes them without being wrong.
 */
const BUILDING_FORGIVEN_M = 12
const BUILDING_PENALTY = 10
// Among candidates that all cross somewhere, prefer the one that crosses least.
const BUILDING_PER_KM = 5
// Green enough to stop looking for something greener.
const GREEN_ENOUGH = 0.55
// How many directions to try before accepting a loop that fits but is grey.
// A cap, not a target: somewhere with no green at all must not spend every
// attempt discovering that, on infrastructure shared with everyone else.
//
// Five, not three. Measured from the middle of a street grid with a large
// wood 1.5 km away: grey loops fit on the first attempt in most directions,
// so at three the sweep had covered barely a quarter turn before settling —
// and sent a 7 km walk east through more grid while the wood sat due west.
// Five buys ±106° around the opening bearing, most of the compass, for at
// most two more routing calls in exactly the places that fit too easily.
const GREEN_SEARCH_ATTEMPTS = 5
// Rotating by roughly a seventh of the compass each time covers new ground
// rather than nudging into the same terrain.
const GREEN_SEARCH_TURN = 53
// How far a via point may be dragged off its circle, as a share of the radius.
// Measured: 0.9 pulled hard enough to break the length promise outright — a 2 km
// ask came back 0.92 km and 2.47 km — so the ceiling here is not squeamishness,
// it is the point past which the loop stops being the length you asked for.
const VIA_NUDGE_SHARE = 0.45

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

/**
 * How much of the track runs over the same street twice — split by the ground
 * it happens on, because the two kinds annoy differently. `overlap` is the
 * whole of it; `greenOverlap` the part where the repeated stretch runs through
 * green, per the router's own land-cover mask. No mask means no split: it all
 * counts as the expensive kind, since "not measured" must not be forgiven as
 * if it were woodland.
 */
function overlapFraction(coords: LngLat[], mask: boolean[] | null = null) {
  const seen = new Set<string>()
  let total = 0
  let repeated = 0
  let greenRepeated = 0
  const key = (p: LngLat) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`
  for (let i = 1; i < coords.length; i++) {
    const len = distanceKm(coords[i - 1], coords[i])
    total += len
    const edge = [key(coords[i - 1]), key(coords[i])].sort().join('|')
    if (seen.has(edge)) {
      repeated += len
      if (mask?.[i - 1]) greenRepeated += len
    } else {
      seen.add(edge)
    }
  }
  if (!total) return { overlap: 0, greenOverlap: 0 }
  return { overlap: repeated / total, greenOverlap: greenRepeated / total }
}

/**
 * The green mask for a trimmed line, from the mask of the line it was cut
 * from. An edge that survived keeps its greenness; an edge the trim invented —
 * bridging where a spur was removed — is unknown, and unknown is priced as
 * grey rather than credited as green.
 */
function remapMask(
  mask: boolean[] | null | undefined,
  origin: number[],
): boolean[] | null {
  if (!mask) return null
  const out: boolean[] = new Array(Math.max(origin.length - 1, 0))
  for (let j = 0; j < origin.length - 1; j++) {
    out[j] = origin[j + 1] === origin[j] + 1 ? (mask[origin[j]] ?? false) : false
  }
  return out
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
  preferGreen = false,
  nudgeVia,
  metresThroughBuildings,
  routeThrough,
}: {
  start: LngLat
  targetKm: number
  bearing: number
  clockwise: boolean
  waypoints?: LngLat[]
  /**
   * Spend attempts looking for a route through woods and parks, and let
   * greenness break a tie between candidates. Off unless the rider asked for
   * nature — someone who wants the quickest loop of the right length should not
   * be sent the scenic one, nor pay the extra routing calls to find it.
   */
  preferGreen?: boolean
  /**
   * Given a generated via point, somewhere greener nearby to use instead — or
   * null to leave it be. Injected, because only the map knows where the parks
   * are and the domain does not talk to the map.
   */
  nudgeVia?: (point: LngLat, maxMoveM: number) => LngLat | null
  /**
   * Metres of a track that run through buildings, or null when the map has no
   * footprints loaded to say. Injected like `nudgeVia`, and for the same
   * reason: only the map has the polygons.
   */
  metresThroughBuildings?: (coords: LngLat[]) => number | null
  routeThrough: RouteThrough
}): Promise<Route> {
  let radius = Math.max(0.12, targetKm / (2 * Math.PI))
  let currentBearing = bearing
  let viaCount = 4
  let greenTries = 0
  let bestGreen = 0
  const searchingGreen = preferGreen && !waypoints.length
  let best: Route | null = null
  let bestScore = Infinity
  let lastError: unknown = null

  for (let attempt = 0; attempt < 7; attempt++) {
    const circle = waypoints.length
      ? loopViaWithWaypoints(start, waypoints, radius, currentBearing, clockwise, viaCount)
      : loopViaPoints(start, radius, currentBearing, clockwise, viaCount)

    // The circle sets the length and keeps the legs apart; it was never meant to
    // be walked exactly. Pull each point onto nearby green and the router threads
    // the legs through parks instead of past them — which is the whole ask, and
    // it costs no extra routing calls.
    const via =
      preferGreen && nudgeVia
        ? circle.map((p) => nudgeVia(p, radius * 1000 * VIA_NUDGE_SHARE) ?? p)
        : circle

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

    // The mask indexes into the untrimmed geometry, like the voice hints; it
    // is remapped alongside everything else that gets cut.
    const routedMask = route.greenMask ?? null
    const { points: trimmed, origin } = trimSpurs(routed, keep)
    if (trimmed.length < route.geometry.coordinates.length) {
      const newKm = polylineKm(trimmed)
      route.durationSec *= newKm / route.distanceKm
      route.distanceKm = newKm
      route.geometry = { ...route.geometry, coordinates: trimmed }
      route.greenMask = remapMask(routedMask, origin)
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
    const bareTrim = waypoints.length ? trimSpurs(routed) : { points: trimmed, origin }
    const { overlap, greenOverlap } = overlapFraction(
      bareTrim.points,
      preferGreen ? remapMask(routedMask, bareTrim.origin) : null,
    )

    // Reaching the stops is not negotiable. Compared against what the router
    // itself achieved, not an absolute distance: a pin dropped in the middle
    // of a field is as reached as it will ever be once the loop is on the
    // nearest path.
    const missed = waypoints.filter(
      (w, i) => nearestVertexM(route.geometry.coordinates, w) > reachedM[i] + TRIM_SLACK_M,
    ).length

    // A missed stop outranks everything; then overlap, priced by the ground it
    // repeats (see OVERLAP_WEIGHT / GREEN_OVERLAP_WEIGHT); then length.
    //
    // And then greenness, which is why a loop starting at the edge of a park
    // used to walk into town instead. The direction of the loop is the single
    // thing that decides this, it was picked at random, and nothing ever
    // measured the result: seven candidates would be generated and the greenest
    // one thrown away because a greyer one was forty metres closer to target.
    // Weighted below overlap and above distance, so it beats a rounding error in
    // length but never sends you round the same block twice.
    const green = preferGreen ? route.greenFraction : null
    const greenScore = typeof green === 'number' ? (1 - green) * GREEN_WEIGHT : 0
    const greyOverlap = overlap - greenOverlap

    const throughM = metresThroughBuildings?.(route.geometry.coordinates) ?? 0
    const buildingScore =
      throughM > BUILDING_FORGIVEN_M
        ? BUILDING_PENALTY + (throughM / 1000) * BUILDING_PER_KM
        : 0

    const lengthScore =
      distErr + Math.max(0, distErr - LENGTH_TOLERANCE) * LENGTH_EXCESS_WEIGHT

    const score =
      missed * 100 +
      buildingScore +
      lengthScore +
      greyOverlap * OVERLAP_WEIGHT +
      greenOverlap * GREEN_OVERLAP_WEIGHT +
      greenScore

    if (score < bestScore) {
      best = route
      bestScore = score
    }
    if (typeof green === 'number') bestGreen = Math.max(bestGreen, green)

    // The overlap the thresholds below judge, priced like the score: repeated
    // green counts at the discount. Without this, a park loop carrying a bit
    // of green doubling could never "fit", and the search would swing away
    // from the very park the score is about to prefer. The discount alone
    // would call a walk a fifth doubled "fitting" though, so the undiscounted
    // figure keeps a ceiling of its own — doubling back is doubling back,
    // whatever the ground, and past that much of it the search should keep
    // looking for a cleaner way round rather than settling.
    const feltOverlap =
      greyOverlap + greenOverlap * (GREEN_OVERLAP_WEIGHT / OVERLAP_WEIGHT)
    const OVERLAP_CEILING = 0.15

    // Good enough to stop — unless there might be a greener way round. The old
    // condition took the first candidate that fitted, which on a park's edge was
    // usually the one heading into town, because the very first bearing tried is
    // a random one. Now a fitting-but-grey loop buys a few more directions
    // before we settle, and a fitting green one still stops immediately.
    const fits =
      !missed &&
      !buildingScore &&
      distErr < 0.06 &&
      feltOverlap < 0.08 &&
      overlap < OVERLAP_CEILING
    const greenEnough = green == null || green >= GREEN_ENOUGH
    if (fits && (greenEnough || attempt >= GREEN_SEARCH_ATTEMPTS)) break
    // With nothing left to remove, over-target means the waypoints themselves
    // demand the distance — a clean loop through them is as good as it gets.
    if (
      waypoints.length &&
      viaCount === 0 &&
      route.distanceKm >= targetKm &&
      feltOverlap < 0.08
    ) {
      break
    }

    const overLength = waypoints.length && route.distanceKm > targetKm * 1.1

    // Still nothing green: sweep the direction, every attempt, whatever the
    // length is doing.
    //
    // Two earlier versions of this failed for the same reason — they only turned
    // when the candidate already fitted on length and overlap, and at a park's
    // edge it usually doesn't, so the bearing never moved and all seven attempts
    // explored one random direction. Refining the radius is worthless if you are
    // refining it in the wrong half of the compass. Alternating sides covers
    // roughly the whole circle over seven attempts, and the radius adaptation
    // below keeps working across them.
    if (searchingGreen && bestGreen < GREEN_ENOUGH && !waypoints.length) {
      greenTries += 1
      const side = greenTries % 2 === 1 ? -1 : 1
      currentBearing = bearing + side * Math.ceil(greenTries / 2) * GREEN_SEARCH_TURN
    } else if (feltOverlap > 0.08) {
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
