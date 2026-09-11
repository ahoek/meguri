import { closestOnSegment, distanceKm } from './geo'
import type { LngLat } from './geo'

/**
 * Cycling node networks — *fietsknooppunten*.
 *
 * In the Netherlands and Belgium you don't navigate by street names, you
 * navigate by numbers: ride to 45, then 78, then 12. The junctions are
 * signposted, so a loop expressed as a sequence of them is one you can follow
 * without looking at a phone at all.
 *
 * This is the pure half: choosing which junctions a loop should pass, and
 * working out which it actually did. Fetching them is infra's job.
 */

export interface NetworkNode {
  /** The number on the signpost. A string: some are "01", a few are lettered. */
  ref: string
  lngLat: LngLat
}

export interface NodeStop extends NetworkNode {
  /** How far along the finished loop this junction sits. */
  atKm: number
}

/** A junction counts as ridden if the line comes this close to it. */
const ON_ROUTE_M = 40

/** Two sightings of one number this far apart are two real visits, not one. */
const REVISIT_KM = 0.5

/** One signposted leg, as OSM records it: `ref="32-33"`. */
export interface NetworkLeg {
  a: string
  b: string
}

/**
 * The network as a graph, which is what it actually is.
 *
 * A route you can ride by the signs is a walk along these edges. Junction
 * positions alone are not enough: standing at 32 the signpost offers only
 * 32's neighbours, so a plan that jumps from 32 to 34 is unfollowable however
 * close the two happen to be.
 *
 * Vertices are keyed by an id rather than by the number, because the numbers
 * are not unique. Neighbouring regions each start again from 1, so a single
 * query around one town routinely returns three junctions called "3". The id
 * disambiguates; `refOf` gives back the number to put on the screen.
 */
export interface NodeNetwork {
  at: Map<string, LngLat>
  refOf: Map<string, string>
  neighbours: Map<string, string[]>
}

/** Nodes of one number this close together are arms of one junction. */
const CLUSTER_KM = 1
/** No signposted leg is longer than this, which resolves which "3" is meant. */
const MAX_LEG_KM = 12

/** Single-link clustering, for the handful of nodes sharing one number. */
function cluster(points: LngLat[]): LngLat[][] {
  const groups: LngLat[][] = []
  for (const p of points) {
    const near = groups.find((g) => g.some((q) => distanceKm(p, q) <= CLUSTER_KM))
    if (near) near.push(p)
    else groups.push([p])
  }
  return groups
}

const centre = (points: LngLat[]): LngLat => {
  const sum = points.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0])
  return [sum[0] / points.length, sum[1] / points.length]
}

/**
 * Fold the raw nodes and legs into a graph.
 *
 * A junction is usually mapped as several nodes, one per approach arm, all
 * carrying the same number — those collapse to one vertex. Where a number
 * turns up again in the next region, both survive as separate vertices, and
 * each leg is attached to whichever pair of them is close enough together to
 * be the one the sign means.
 */
export function buildNetwork(nodes: NetworkNode[], legs: NetworkLeg[]): NodeNetwork {
  const grouped = new Map<string, LngLat[]>()
  for (const node of nodes) {
    const list = grouped.get(node.ref)
    if (list) list.push(node.lngLat)
    else grouped.set(node.ref, [node.lngLat])
  }

  const at = new Map<string, LngLat>()
  const refOf = new Map<string, string>()
  const idsByRef = new Map<string, string[]>()

  for (const [ref, points] of grouped) {
    const groups = cluster(points)
    const ids = groups.map((group, i) => {
      // Keep the id readable where the number is unambiguous, which it
      // usually is; only collisions need a suffix.
      const id = groups.length === 1 ? ref : `${ref}#${i}`
      at.set(id, centre(group))
      refOf.set(id, ref)
      return id
    })
    idsByRef.set(ref, ids)
  }

  const neighbours = new Map<string, string[]>()
  const seen = new Set<string>()
  const link = (a: string, b: string) => {
    let list = neighbours.get(a)
    if (!list) neighbours.set(a, (list = []))
    list.push(b)
  }

  for (const { a, b } of legs) {
    if (a === b) continue
    const aIds = idsByRef.get(a) ?? []
    const bIds = idsByRef.get(b) ?? []
    // The sign at one 3 points at the 3 next door, not the one two towns
    // over: of every pairing the number allows, take the closest.
    let pick: [string, string] | null = null
    let bestKm = MAX_LEG_KM
    for (const ai of aIds) {
      for (const bi of bIds) {
        const d = distanceKm(at.get(ai)!, at.get(bi)!)
        if (d < bestKm) {
          bestKm = d
          pick = [ai, bi]
        }
      }
    }
    if (!pick) continue
    const key = pick[0] < pick[1] ? `${pick[0]}|${pick[1]}` : `${pick[1]}|${pick[0]}`
    if (seen.has(key)) continue
    seen.add(key)
    link(pick[0], pick[1])
    link(pick[1], pick[0])
  }

  return { at, refOf, neighbours }
}

/** The junction nearest a point that actually has legs to ride. */
export function nearestJunction(network: NodeNetwork, to: LngLat): string | null {
  let best: string | null = null
  let bestKm = Infinity
  for (const [id, at] of network.at) {
    if (!network.neighbours.get(id)?.length) continue
    const d = distanceKm(to, at)
    if (d < bestKm) {
      bestKm = d
      best = id
    }
  }
  return best
}

/** The junction to set off from: nearest to the start that has legs at all. */
export function entryJunction(network: NodeNetwork, from: LngLat): string | null {
  let best: string | null = null
  let bestKm = Infinity
  for (const [ref, at] of network.at) {
    if (!network.neighbours.get(ref)?.length) continue
    const d = distanceKm(from, at)
    if (d < bestKm) {
      bestKm = d
      best = ref
    }
  }
  return best
}

// Legs bend, so the straight line between two junctions understates them.
const DETOUR = 1.25
// How much a ride's shape counts against its length. A round trip that comes
// straight back past the door is the right distance and the wrong ride.
const ROUNDNESS_WEIGHT = 0.7
// A stop the rider asked for outranks both length and shape, as it does in
// the ordinary planner.
const MISSED_STOP_WEIGHT = 2

/**
 * How much like a circle a closed shape is: 1 for a circle, 0 for a line
 * doubled back on itself. The isoperimetric quotient, which is exactly the
 * question "is this a round, or an out-and-back with extra steps".
 */
function roundness(ring: LngLat[]): number {
  if (ring.length < 3) return 0
  const kx = 111.32 * Math.cos((ring[0][1] * Math.PI) / 180)
  const ky = 110.57
  let twiceArea = 0
  let perimeter = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    const q = ring[(i + 1) % ring.length]
    twiceArea += p[0] * kx * (q[1] * ky) - q[0] * kx * (p[1] * ky)
    perimeter += Math.hypot((q[0] - p[0]) * kx, (q[1] - p[1]) * ky)
  }
  if (perimeter <= 0) return 0
  return (4 * Math.PI * (Math.abs(twiceArea) / 2)) / (perimeter * perimeter)
}
// How far off target a closed walk may land and still be worth routing.
const LENGTH_SLACK = 0.18

/**
 * Find a ride: a closed walk through adjacent junctions, near the target
 * length, starting and finishing at `entry`.
 *
 * Randomised greedy with restarts rather than anything clever. The graph is
 * small, the walks are six to a dozen legs, and the thing being optimised —
 * "a nice round of about this far" — has no single right answer, so trying
 * several hundred and keeping the best beats searching exhaustively for an
 * optimum nobody asked for.
 *
 * No junction is visited twice and no leg ridden twice, so what comes back is
 * a simple loop. Forbidding only the legs was not enough: the walk could run
 * out to a junction, go round from there and come back to it, which is a
 * lollipop with a stem, not a round.
 */
export function findNodeLoop(
  network: NodeNetwork,
  entry: string,
  targetKm: number,
  {
    attempts = 400,
    random = Math.random,
    finishes,
    connectorKm = () => 0,
    homeAt,
    mustPass = [],
  }: {
    attempts?: number
    random?: () => number
    /** Junctions the ride may end at. Defaults to finishing where it began. */
    finishes?: ReadonlySet<string>
    /** Getting from the doorstep to a junction, and back from another. */
    connectorKm?: (id: string) => number
    /** The doorstep, so the shape of the whole ride can be judged. */
    homeAt?: LngLat
    /** Junctions the rider's own stops sit nearest to. */
    mustPass?: string[]
  } = {},
): { plan: string[]; score: number } | null {
  if (!network.at.has(entry)) return null
  const canFinish = (id: string) => (finishes ? finishes.has(id) : id === entry)
  // A stop the rider asked for can sit further out than the target allows,
  // and a simple loop that reaches it has to be longer. Let it be: the score
  // still counts every kilometre over, so the ride becomes as short as the
  // stops permit rather than as short as the slider said.
  const ceiling = targetKm * (mustPass.length ? 2 : 1 + LENGTH_SLACK)
  // The ride out to the network and home from it are part of the distance
  // asked for, so the walk between them has that much less to cover.
  const out = connectorKm(entry)

  const straight = (a: string, b: string) => {
    const pa = network.at.get(a)
    const pb = network.at.get(b)
    return pa && pb ? distanceKm(pa, pb) * DETOUR : Infinity
  }

  let best: { plan: string[]; score: number } | null = null

  for (let attempt = 0; attempt < attempts; attempt++) {
    const path = [entry]
    const usedLegs = new Set<string>()
    let length = out

    for (let step = 0; step < 40; step++) {
      const here = path[path.length - 1]
      const options: { to: string; legKm: number; closes: boolean }[] = []

      for (const to of network.neighbours.get(here) ?? []) {
        const key = here < to ? `${here}|${to}` : `${to}|${here}`
        if (usedLegs.has(key)) continue
        const legKm = straight(here, to)
        const home = connectorKm(to)
        const total = length + legKm + home
        // Refuse a step we could not get home from inside the budget.
        if (total > ceiling) continue

        const enough = total >= targetKm * (1 - LENGTH_SLACK)
        const closes = canFinish(to) && path.length >= 3 && enough
        // Coming back to somewhere already ridden makes a stem, not a round.
        // The one exception is shutting the loop at the junction it opened.
        if (path.includes(to) && !(to === entry && closes)) continue

        options.push({ to, legKm, closes })
      }

      if (!options.length) break

      // Close it when closing is on offer; otherwise wander, favouring
      // junctions not yet visited so the ride goes round rather than
      // shuttling between two ends of the same street.
      const closer =
        options.find((o) => o.closes && o.to !== entry) ?? options.find((o) => o.closes)
      const pick =
        closer ??
        (() => {
          const fresh = options.filter((o) => !path.includes(o.to))
          const pool = fresh.length ? fresh : options
          return pool[Math.floor(random() * pool.length)]
        })()

      const key =
        here < pick.to ? `${here}|${pick.to}` : `${pick.to}|${here}`
      usedLegs.add(key)
      length += pick.legKm
      path.push(pick.to)

      if (pick.closes) {
        const total = length + connectorKm(pick.to)
        const ring = homeAt
          ? [homeAt, ...path.map((id) => network.at.get(id)!)]
          : path.map((id) => network.at.get(id)!)
        const missed = mustPass.filter((id) => !path.includes(id)).length
        const score =
          Math.abs(total - targetKm) / targetKm +
          (1 - roundness(ring)) * ROUNDNESS_WEIGHT +
          missed * MISSED_STOP_WEIGHT
        if (!best || score < best.score) best = { plan: [...path], score }
        break
      }
    }
  }

  return best
}

/**
 * The planned junctions, placed on the finished line.
 *
 * The sequence shown is the plan, because the plan is what the signposts
 * say — but how far along each one sits has to come from the geometry that
 * came back, which is what the ladder counts down to.
 */
export function stopsForPlan(
  coords: LngLat[],
  network: NodeNetwork,
  plan: string[],
): NodeStop[] {
  if (coords.length < 2) return []
  const cumulative: number[] = new Array(coords.length)
  cumulative[0] = 0
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + distanceKm(coords[i - 1], coords[i])
  }

  let from = 0
  return plan.map((id) => {
    const at = network.at.get(id)!
    let bestKm = Infinity
    let bestAt = cumulative[from]
    // Scan forward only: a loop meets its start twice, and the second
    // sighting of the entry junction belongs at the end, not the beginning.
    for (let i = from; i < coords.length - 1; i++) {
      const near = closestOnSegment(coords[i], coords[i + 1], at)
      const d = distanceKm(at, near)
      if (d < bestKm) {
        bestKm = d
        bestAt = cumulative[i] + distanceKm(coords[i], near)
        from = i
      }
    }
    return { ref: network.refOf.get(id) ?? id, lngLat: at, atKm: bestAt }
  })
}

/**
 * Which junctions the finished loop actually passes, in the order ridden.
 *
 * Derived from the geometry rather than from what we asked for: spur trimming
 * and the router's own choices both move the line, and a sequence that lists
 * a junction the route no longer reaches is worse than no sequence at all.
 */
export function nodesAlongRoute(
  coords: LngLat[],
  nodes: NetworkNode[],
  toleranceM = ON_ROUTE_M,
): NodeStop[] {
  if (coords.length < 2 || !nodes.length) return []

  const cumulative: number[] = new Array(coords.length)
  cumulative[0] = 0
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + distanceKm(coords[i - 1], coords[i])
  }

  const limit = toleranceM / 1000
  const stops: NodeStop[] = []

  for (const node of nodes) {
    // Distance to the line, not to its corners: route vertices sit hundreds
    // of metres apart on a straight, and measuring to the nearest one hid
    // junctions the loop rides straight past.
    //
    // Tracked as runs of closeness rather than one global minimum, so a loop
    // that passes the same junction twice — which the start and finish of a
    // round trip often do — reports both.
    let runBest = Infinity
    let runAt = 0
    let inRun = false
    for (let i = 0; i < coords.length - 1; i++) {
      const near = closestOnSegment(coords[i], coords[i + 1], node.lngLat)
      const d = distanceKm(node.lngLat, near)
      if (d <= limit) {
        if (!inRun || d < runBest) {
          runBest = d
          runAt = cumulative[i] + distanceKm(coords[i], near)
        }
        inRun = true
      } else if (inRun) {
        stops.push({ ...node, atKm: runAt })
        inRun = false
        runBest = Infinity
      }
    }
    if (inRun) stops.push({ ...node, atKm: runAt })
  }

  stops.sort((a, b) => a.atKm - b.atKm)

  // Neighbouring sightings of the same number are one visit seen twice.
  return stops.filter((stop, i) => {
    const prev = stops[i - 1]
    return !prev || prev.ref !== stop.ref || stop.atKm - prev.atKm > REVISIT_KM
  })
}
