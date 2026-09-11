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
 * This is the pure half: folding what OpenStreetMap knows into a graph,
 * choosing which junctions a ride should pass, turning a signposted leg's
 * ways into one line, and placing the numbers on the finished route.
 * Fetching any of it is infra's job.
 */

export interface NetworkNode {
  /** The number on the signpost. A string: some are "01", a few are lettered. */
  ref: string
  lngLat: LngLat
}

/** One signposted leg, as OSM records it: a relation with `ref="32-33"`. */
export interface NetworkLeg {
  a: string
  b: string
  /** The relation's id, which is how its geometry is asked for later. */
  id: number
  /** Its real length along the ways, which Overpass can measure for us. */
  km: number
  /**
   * Where it lies, as [west, south, east, north]. Numbers repeat from one
   * region to the next, so the two junctions a leg joins are found inside
   * its own box, not anywhere its length would reach.
   */
  bounds?: [number, number, number, number]
}

/** A junction placed on the finished route. */
export interface NodeStop extends NetworkNode {
  /** How far along the route this junction sits. */
  atKm: number
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
  /** The leg between two vertices, keyed by `legKey`. */
  legs: Map<string, NetworkLeg>
}

/** Nodes of one number this close together are arms of one junction. */
const CLUSTER_KM = 1
/**
 * A leg can be no shorter than the straight line between its ends. Measured
 * around Den Haag: 28 of 259 legs had a far end outside the query box, and
 * the nearest junction *inside* it with that number was another junction
 * entirely — up to 17 km away from a 650 m leg. Riding a plan built on that
 * pairing would send you to the wrong 18. The slack covers junction arms
 * clustering to a centroid a few metres off the road.
 */
const LEG_STRAIGHTNESS_SLACK = 1.05
const LEG_STRAIGHTNESS_SLACK_KM = 0.05
// A junction's arms cluster to a centroid that can sit a little outside the
// leg's box; about 300 m of grace.
const BOUNDS_MARGIN_DEG = 0.003

function insideBounds([lng, lat]: LngLat, [w, s, e, n]: [number, number, number, number]) {
  return (
    lng >= w - BOUNDS_MARGIN_DEG &&
    lng <= e + BOUNDS_MARGIN_DEG &&
    lat >= s - BOUNDS_MARGIN_DEG &&
    lat <= n + BOUNDS_MARGIN_DEG
  )
}

export const legKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`)

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
 * each leg is attached to whichever pair of them its length allows: the
 * closest pair the leg is long enough to join, or none.
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
  const legOf = new Map<string, NetworkLeg>()
  const link = (a: string, b: string) => {
    let list = neighbours.get(a)
    if (!list) neighbours.set(a, (list = []))
    list.push(b)
  }

  for (const leg of legs) {
    if (leg.a === leg.b || !(leg.km > 0)) continue
    const near = (id: string) => !leg.bounds || insideBounds(at.get(id)!, leg.bounds)
    const aIds = (idsByRef.get(leg.a) ?? []).filter(near)
    const bIds = (idsByRef.get(leg.b) ?? []).filter(near)
    // The sign at one 3 points at the 3 next door, not the one two towns
    // over: of every pairing the number allows, take the closest — and only
    // if the leg is long enough to reach it at all.
    let pick: [string, string] | null = null
    let bestKm = leg.km * LEG_STRAIGHTNESS_SLACK + LEG_STRAIGHTNESS_SLACK_KM
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
    const key = legKey(pick[0], pick[1])
    // Two relations for one pair — a leg mapped twice, or once per
    // direction — are one leg; keep the shorter, which is the ride itself.
    const held = legOf.get(key)
    if (held) {
      if (leg.km < held.km) legOf.set(key, { ...leg, a: pick[0], b: pick[1] })
      continue
    }
    legOf.set(key, { ...leg, a: pick[0], b: pick[1] })
    link(pick[0], pick[1])
    link(pick[1], pick[0])
  }

  return { at, refOf, neighbours, legs: legOf }
}

/** The network with one leg struck out — for when its geometry proves unusable. */
export function withoutLeg(network: NodeNetwork, a: string, b: string): NodeNetwork {
  const legs = new Map(network.legs)
  legs.delete(legKey(a, b))
  const neighbours = new Map(network.neighbours)
  neighbours.set(a, (neighbours.get(a) ?? []).filter((id) => id !== b))
  neighbours.set(b, (neighbours.get(b) ?? []).filter((id) => id !== a))
  return { ...network, legs, neighbours }
}

/** The network with one leg's length corrected — by its geometry, once fetched. */
export function withLegKm(network: NodeNetwork, a: string, b: string, km: number): NodeNetwork {
  const key = legKey(a, b)
  const leg = network.legs.get(key)
  if (!leg) return network
  const legs = new Map(network.legs)
  legs.set(key, { ...leg, km })
  return { ...network, legs }
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

// How much a ride's shape counts against its length. A round trip that comes
// straight back past the door is the right distance and the wrong ride.
const ROUNDNESS_WEIGHT = 0.7
// A stop the rider asked for outranks both length and shape, as it does in
// the ordinary planner.
const MISSED_STOP_WEIGHT = 2
// How far off target a closed walk may land and still be worth routing.
const LENGTH_SLACK = 0.18
/**
 * Inside this band the length is a tie-breaker; outside it, it is the point.
 * The first version closed a ride at the first junction that would do, which
 * on a network of two-kilometre legs landed a 25 km ask at 19.8 km — a fifth
 * short, and rounder for it. Now a ride goes on past a chance to close
 * unless it is already near the target, and a miss beyond the band is
 * charged steeply enough that no amount of roundness buys it back.
 */
const LENGTH_BAND = 0.08
const LENGTH_EXCESS_WEIGHT = 4
/**
 * What the ride out to the network and home from it costs, as a share of the
 * whole. Those stretches are the part with no numbers on the signs; on a
 * 40 km ask they ran to seven kilometres before this, because a junction
 * nearly five kilometres off was as good a place to start as the one at the
 * end of the street.
 */
const CONNECTOR_WEIGHT = 2
/**
 * A leg that runs past the doorstep is not for riding: the way out to the
 * network already covers that ground, so a ride that then takes the leg
 * comes back past the door and doubles the connector. Legs are judged by
 * the straight line between their junctions — it is the one thing known
 * about their shape before the geometry is fetched, and the leg past your
 * house is the one whose ends are the two junctions nearest you, which the
 * straight line finds.
 */
const DOORSTEP_KM = 0.25

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

function lengthCost(totalKm: number, targetKm: number) {
  const error = Math.abs(totalKm - targetKm) / targetKm
  return error <= LENGTH_BAND ? error : LENGTH_BAND + (error - LENGTH_BAND) * LENGTH_EXCESS_WEIGHT
}

interface Option {
  to: string
  legKm: number
  total: number
  closes: boolean
  at: LngLat
}

/**
 * Which way to wander: out while there is distance to spend, home as it runs
 * out, the way a round goes.
 *
 * Picking the next junction uniformly at random found 25 km rides and
 * almost never a 40 km one — a walk that is not steered wanders off and is
 * far from every finish by the time the budget says turn back, and the
 * attempt is wasted. So each step prefers junctions at about the distance
 * from home a round of this length would be at this point in it — rising
 * to the far side, falling back to the door — weighted, not forced, so the
 * attempts still differ and the network's shape still decides.
 */
function steer(
  movers: Option[],
  lengthKm: number,
  targetKm: number,
  home: LngLat,
  outKm: number,
  random: () => number,
): Option {
  const progress = Math.min(1, Math.max(0, (lengthKm - outKm) / Math.max(targetKm - outKm, 0.1)))
  // A circle of this circumference; a real ride is rounder than a line and
  // squarer than a circle, and the tolerance below covers the difference.
  const radius = targetKm / (2 * Math.PI)
  const wanted = 2 * radius * Math.sin(Math.PI * progress)
  const tolerance = Math.max(radius * 0.5, 0.8)
  const weights = movers.map((o) => {
    const off = (distanceKm(home, o.at) - wanted) / tolerance
    return Math.exp(-off * off) + 0.02
  })
  let roll = random() * weights.reduce((a, b) => a + b, 0)
  for (let i = 0; i < movers.length; i++) {
    roll -= weights[i]
    if (roll <= 0) return movers[i]
  }
  return movers[movers.length - 1]
}

/**
 * Find a ride: a closed walk through adjacent junctions, near the target
 * length, starting at `entry`.
 *
 * Randomised greedy with restarts rather than anything clever. The graph is
 * small, the walks are six to a dozen legs, and the thing being optimised —
 * "a nice round of about this far" — has no single right answer, so trying
 * several hundred and keeping the best beats searching exhaustively for an
 * optimum nobody asked for. Lengths are the legs' real lengths, so what the
 * search believes about distance is what the road will say.
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
): { plan: string[]; km: number; score: number } | null {
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
  const legKm = (a: string, b: string) => network.legs.get(legKey(a, b))?.km ?? Infinity
  const home = homeAt ?? network.at.get(entry)!
  const pastDoor = (a: string, b: string) => {
    if (!homeAt) return false
    const pa = network.at.get(a)!
    const pb = network.at.get(b)!
    // A leg that begins or ends beside the door is the way onto the network,
    // not a leg past it: living at a junction must not strand the search.
    if (Math.min(distanceKm(homeAt, pa), distanceKm(homeAt, pb)) <= DOORSTEP_KM * 1.5) return false
    return distanceKm(homeAt, closestOnSegment(pa, pb, homeAt)) <= DOORSTEP_KM
  }

  let best: { plan: string[]; km: number; score: number } | null = null

  for (let attempt = 0; attempt < attempts; attempt++) {
    const path = [entry]
    const usedLegs = new Set<string>()
    let length = out

    for (let step = 0; step < 40; step++) {
      const here = path[path.length - 1]
      const options: Option[] = []

      for (const to of network.neighbours.get(here) ?? []) {
        const key = legKey(here, to)
        if (usedLegs.has(key) || pastDoor(here, to)) continue
        const km = legKm(here, to)
        const total = length + km + connectorKm(to)
        // Refuse a step we could not get home from inside the budget.
        if (total > ceiling) continue

        const enough = total >= targetKm * (1 - LENGTH_SLACK)
        const closes = canFinish(to) && path.length >= 3 && enough
        // Coming back to somewhere already ridden makes a stem, not a round.
        // The one exception is shutting the loop at the junction it opened.
        if (path.includes(to) && !(to === entry && closes)) continue

        options.push({ to, legKm: km, total, closes, at: network.at.get(to)! })
      }

      if (!options.length) break

      // Close when the ride is already about the right length; otherwise
      // wander on — a finish junction can be ridden through — and close
      // only when there is nowhere else to go.
      const closers = options.filter((o) => o.closes)
      const near = closers.filter((o) => o.total >= targetKm * (1 - LENGTH_BAND))
      const movers = options.filter((o) => o.to !== entry)
      let pick: Option
      let close: boolean
      if (near.length) {
        pick = near.reduce((a, b) =>
          Math.abs(b.total - targetKm) < Math.abs(a.total - targetKm) ? b : a,
        )
        close = true
      } else if (movers.length) {
        pick = steer(movers, length, targetKm, home, out, random)
        close = false
      } else {
        pick = closers[0]
        close = true
      }

      usedLegs.add(legKey(here, pick.to))
      length += pick.legKm
      path.push(pick.to)

      if (close) {
        const total = pick.total
        const ring = homeAt
          ? [homeAt, ...path.map((id) => network.at.get(id)!)]
          : path.map((id) => network.at.get(id)!)
        const missed = mustPass.filter((id) => !path.includes(id)).length
        const score =
          lengthCost(total, targetKm) +
          (1 - roundness(ring)) * ROUNDNESS_WEIGHT +
          ((out + connectorKm(pick.to)) / targetKm) * CONNECTOR_WEIGHT +
          missed * MISSED_STOP_WEIGHT
        if (!best || score < best.score) best = { plan: [...path], km: total, score }
        break
      }
    }
  }

  return best
}

/** One member way of a leg's relation: its points, and which way it may be ridden. */
export interface LegWay {
  /** "", "forward" or "backward" — how OSM marks the two sides of a split path. */
  role: string
  points: LngLat[]
}

// Way endpoints this close together are the same corner, mapped twice.
const GAP_BRIDGE_KM = 0.03
// A stitched leg has to arrive at the junction it claims to join. Measured
// on twelve real legs the ends sat within 52 m of the junctions' centroids.
const JUNCTION_REACH_KM = 0.15

const vertexKey = (p: LngLat) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`

/**
 * One line from junction `from` to junction `to`, along the leg's own ways.
 *
 * The relation is a bag of ways, not a line: they arrive in any order and
 * either orientation, and nearly half of the legs measured around Den Haag
 * carry `forward`/`backward` members — a cycle path on each side of the
 * road, each ridden one way. Chaining ways end to end broke on those. So the
 * ways become a small graph and the leg is the shortest path through it, in
 * the direction the roles allow; if the roles don't join up (data is data)
 * the same search runs ignoring them. Null when the ways don't reach both
 * junctions, so the caller can strike the leg rather than ride a guess.
 */
export function stitchLeg(ways: LegWay[], from: LngLat, to: LngLat): LngLat[] | null {
  return walkWays(ways, from, to, true) ?? walkWays(ways, from, to, false)
}

function walkWays(
  ways: LegWay[],
  from: LngLat,
  to: LngLat,
  directed: boolean,
): LngLat[] | null {
  const adjacent = new Map<string, { to: string; km: number }[]>()
  const position = new Map<string, LngLat>()
  const add = (a: LngLat, b: LngLat) => {
    const ka = vertexKey(a)
    const kb = vertexKey(b)
    if (ka === kb) return
    position.set(ka, a)
    position.set(kb, b)
    let list = adjacent.get(ka)
    if (!list) adjacent.set(ka, (list = []))
    list.push({ to: kb, km: distanceKm(a, b) })
  }

  for (const way of ways) {
    for (let i = 1; i < way.points.length; i++) {
      const a = way.points[i - 1]
      const b = way.points[i]
      if (!directed || way.role !== 'backward') add(a, b)
      if (!directed || way.role !== 'forward') add(b, a)
    }
  }
  if (!position.size) return null

  // Bridge the small gaps where two ways nearly meet.
  const ends = ways.flatMap((w) => (w.points.length ? [w.points[0], w.points[w.points.length - 1]] : []))
  for (const a of ends) {
    for (const b of ends) {
      const d = distanceKm(a, b)
      if (d > 0 && d <= GAP_BRIDGE_KM) add(a, b)
    }
  }

  const nearest = (p: LngLat) => {
    let best = ''
    let bestKm = Infinity
    for (const [key, q] of position) {
      const d = distanceKm(p, q)
      if (d < bestKm) {
        bestKm = d
        best = key
      }
    }
    return bestKm <= JUNCTION_REACH_KM ? best : null
  }
  const source = nearest(from)
  const target = nearest(to)
  if (!source || !target) return null

  // Dijkstra, plainly: a leg has a few hundred vertices at most.
  const dist = new Map<string, number>([[source, 0]])
  const prev = new Map<string, string>()
  const done = new Set<string>()
  for (;;) {
    let here: string | null = null
    let hereKm = Infinity
    for (const [key, km] of dist) {
      if (!done.has(key) && km < hereKm) {
        hereKm = km
        here = key
      }
    }
    if (here == null || here === target) break
    done.add(here)
    for (const edge of adjacent.get(here) ?? []) {
      const km = hereKm + edge.km
      if (km < (dist.get(edge.to) ?? Infinity)) {
        dist.set(edge.to, km)
        prev.set(edge.to, here)
      }
    }
  }
  if (!dist.has(target)) return null

  const line: LngLat[] = []
  for (let key: string | undefined = target; key; key = prev.get(key)) {
    line.push(position.get(key)!)
  }
  return line.reverse()
}

/**
 * Turn cues read off a leg's own geometry, in the router's voice-hint shape
 * (`[pointIndex, command, exit, distanceToNext, angle]`, BRouter's codes).
 *
 * The legs are ridden as OpenStreetMap draws them, so no router ever looks
 * at them and nothing says where the turns are. Geometry does, roughly: a
 * bearing change of a real turn's size at a vertex is a turn. Bearings are
 * taken over a few metres either side rather than to the adjacent vertex,
 * because mapped curves come as many short segments and each would read as
 * a turn of its own. Gentle bends are left unsaid; on a knooppuntenroute the
 * signs carry the rest.
 */
const TURN_REACH_KM = 0.012
const TURN_SLIGHT_DEG = 28
const TURN_PLAIN_DEG = 55
const TURN_SHARP_DEG = 118
// BRouter's command codes, as navigation reads them.
const CMD = { slightLeft: 3, left: 2, sharpLeft: 4, slightRight: 6, right: 5, sharpRight: 7 }

function bearingDeg(a: LngLat, b: LngLat) {
  const k = Math.cos((a[1] * Math.PI) / 180)
  return (Math.atan2((b[0] - a[0]) * k, b[1] - a[1]) * 180) / Math.PI
}

export function turnHintsAlong(coords: LngLat[], from: number, to: number): number[][] {
  const hints: number[][] = []
  for (let i = from + 1; i < to; i++) {
    // Reach back and forward until the bearings are taken over real distance.
    let back = i - 1
    while (back > from && distanceKm(coords[back], coords[i]) < TURN_REACH_KM) back--
    let ahead = i + 1
    while (ahead < to && distanceKm(coords[i], coords[ahead]) < TURN_REACH_KM) ahead++
    // No room to measure over: at the ends of the stretch a bearing taken
    // across a couple of metres is noise, and noise here is a spoken turn.
    if (
      distanceKm(coords[back], coords[i]) < TURN_REACH_KM / 2 ||
      distanceKm(coords[i], coords[ahead]) < TURN_REACH_KM / 2
    ) {
      continue
    }

    let turn = bearingDeg(coords[i], coords[ahead]) - bearingDeg(coords[back], coords[i])
    turn = ((turn + 540) % 360) - 180 // (-180, 180], positive is right
    const size = Math.abs(turn)
    if (size < TURN_SLIGHT_DEG) continue
    const right = turn > 0
    const command =
      size >= TURN_SHARP_DEG
        ? right
          ? CMD.sharpRight
          : CMD.sharpLeft
        : size >= TURN_PLAIN_DEG
          ? right
            ? CMD.right
            : CMD.left
          : right
            ? CMD.slightRight
            : CMD.slightLeft
    hints.push([i, command, 0, 0, Math.round(turn)])
  }
  return hints
}

/**
 * The planned junctions, placed on the finished line.
 *
 * The sequence shown is the plan, because the plan is what the signposts
 * say — but how far along each one sits has to come from the geometry that
 * came back, which is what navigation counts down to.
 */
export function stopsForPlan(coords: LngLat[], stops: NetworkNode[]): NodeStop[] {
  if (coords.length < 2) return []
  const cumulative: number[] = new Array(coords.length)
  cumulative[0] = 0
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + distanceKm(coords[i - 1], coords[i])
  }

  let from = 0
  return stops.map((stop) => {
    let bestKm = Infinity
    let bestAt = cumulative[from]
    let bestIndex = from
    // Scan forward only: a loop meets its start twice, and the second
    // sighting of the entry junction belongs at the end, not the beginning.
    for (let i = from; i < coords.length - 1; i++) {
      const near = closestOnSegment(coords[i], coords[i + 1], stop.lngLat)
      const d = distanceKm(stop.lngLat, near)
      if (d < bestKm) {
        bestKm = d
        bestAt = cumulative[i] + distanceKm(coords[i], near)
        bestIndex = i
      }
    }
    from = bestIndex
    return { ref: stop.ref, lngLat: stop.lngLat, atKm: bestAt }
  })
}

/**
 * The junctions a line rides through, in order, with how far along.
 *
 * For the two connectors: a way home that runs straight through 54 has
 * passed a sign, and a ride that does not say so is not the ride you rode.
 * Distance is to the line, not its vertices, which sit far apart on a
 * straight; only junctions with legs count, as elsewhere.
 */
// A junction's badge is the centroid of its arm nodes, which can sit fifty
// metres off the crossing the connector actually rides through.
const PASSED_M = 50

export function junctionsAlong(
  coords: LngLat[],
  network: NodeNetwork,
  toleranceM = PASSED_M,
): { id: string; atKm: number }[] {
  if (coords.length < 2) return []
  const cumulative = [0]
  for (let i = 1; i < coords.length; i++) {
    cumulative.push(cumulative[i - 1] + distanceKm(coords[i - 1], coords[i]))
  }
  const limit = toleranceM / 1000
  const out: { id: string; atKm: number }[] = []
  for (const [id, at] of network.at) {
    if (!network.neighbours.get(id)?.length) continue
    let bestKm = Infinity
    let bestAt = 0
    for (let i = 0; i < coords.length - 1; i++) {
      const near = closestOnSegment(coords[i], coords[i + 1], at)
      const d = distanceKm(at, near)
      if (d < bestKm) {
        bestKm = d
        bestAt = cumulative[i] + distanceKm(coords[i], near)
      }
    }
    if (bestKm <= limit) out.push({ id, atKm: bestAt })
  }
  return out.sort((a, b) => a.atKm - b.atKm)
}

/**
 * Where numbered cycling junctions exist at all.
 *
 * The Netherlands and Belgium have the network everywhere; the German and
 * French border regions have stretches of it. Elsewhere the switch would only
 * ever produce "no network here", so it is not offered — a coarse box, and
 * one that costs no request to check.
 */
export function inNetworkCountries([lng, lat]: LngLat): boolean {
  return lat >= 49 && lat <= 54 && lng >= 2 && lng <= 8
}
