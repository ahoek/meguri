import { describe, expect, it } from 'vitest'
import {
  buildNetwork,
  findNodeLoop,
  inNetworkCountries,
  junctionsAlong,
  legKey,
  stitchLeg,
  stopsForPlan,
  turnHintsAlong,
  withoutLeg,
} from '../src/domain/knooppunten'
import { ORIGIN, offset, metresBetween } from './helpers'
import type { LegWay, NetworkLeg, NetworkNode } from '../src/domain/knooppunten'
import type { LngLat } from '../src/domain/geo'

const node = (ref: string, east: number, north: number): NetworkNode => ({
  ref,
  lngLat: offset(ORIGIN, east, north),
})

let nextId = 1
/** A leg with its length taken from the straight line, plus a bend allowance. */
const leg = (a: string, b: string, km: number): NetworkLeg => ({ a, b, id: nextId++, km })

// Deterministic, so a failure is reproducible.
const seeded = (s = 12345) => () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

// A 4x4 grid of junctions, numbered r0c0 style, joined only to their
// orthogonal neighbours — a small stand-in for a real network.
function grid(spacingM = 1000, size = 4) {
  const nodes: NetworkNode[] = []
  const legs: NetworkLeg[] = []
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      nodes.push({ ref: `${r}${c}`, lngLat: offset(ORIGIN, c * spacingM, r * spacingM) })
      if (c) legs.push(leg(`${r}${c - 1}`, `${r}${c}`, (spacingM / 1000) * 1.1))
      if (r) legs.push(leg(`${r - 1}${c}`, `${r}${c}`, (spacingM / 1000) * 1.1))
    }
  }
  return buildNetwork(nodes, legs)
}

describe('folding OSM into a graph', () => {
  it('joins each junction only to its real neighbours', () => {
    const net = grid()
    expect(net.neighbours.get('00')!.sort()).toEqual(['01', '10'])
    expect(net.neighbours.get('11')!.sort()).toEqual(['01', '10', '12', '21'])
  })

  it('carries each leg with its measured length', () => {
    const net = grid()
    expect(net.legs.get(legKey('00', '01'))!.km).toBeCloseTo(1.1)
    expect(net.legs.get(legKey('01', '00'))).toBe(net.legs.get(legKey('00', '01')))
  })

  // Neighbouring regions each number from 1, so one query around a town
  // returns several junctions with the same number. Dropping them gutted the
  // graph — 77 of 105 numbers went, leaving too few legs to plan a ride. Both
  // survive, and the leg attaches to whichever pair the sign can mean.
  it('keeps both when a number is reused in the next region', () => {
    const near = offset(ORIGIN, 1000, 0)
    const faraway = offset(ORIGIN, 30_000, 0)
    const net = buildNetwork(
      [
        { ref: '7', lngLat: ORIGIN },
        { ref: '7', lngLat: faraway },
        { ref: '8', lngLat: near },
      ],
      [leg('7', '8', 1.2)],
    )

    expect([...net.at.keys()].sort()).toEqual(['7#0', '7#1', '8'])
    // The leg joins 8 to the 7 beside it, not the one thirty kilometres away.
    expect(net.neighbours.get('8')).toEqual(['7#0'])
    expect(net.neighbours.get('7#1') ?? []).toEqual([])
  })

  // Measured around Den Haag: 28 of 259 legs had their far junction outside
  // the query box, and the only junction *inside* it with that number was a
  // different one — a 650 m leg "10-12" paired with a 12 seventeen kilometres
  // off. A leg cannot be shorter than the straight line between its ends, so
  // that pairing is refused rather than ridden.
  it('refuses a pairing the leg is too short to reach', () => {
    const net = buildNetwork(
      [node('10', 0, 0), node('12', 17_000, 0)],
      [leg('10', '12', 0.65)],
    )
    expect(net.neighbours.get('10') ?? []).toEqual([])
    expect(net.legs.size).toBe(0)
  })

  // With a few tiles loaded the same numbers occur many times over, and a
  // leg forty kilometres away was attached to a pair that merely lay within
  // its length of each other. A leg's box says where it is.
  it('pairs a leg only with junctions inside its own bounds', () => {
    const far = 30_000
    const net = buildNetwork(
      [node('23', 0, 0), node('80', 1000, 0), node('23', far, 0), node('80', far + 1000, 0)],
      [
        {
          ...leg('23', '80', 1.2),
          bounds: [ORIGIN[0] + far / 68_000 - 0.001, ORIGIN[1] - 0.001, ORIGIN[0] + (far + 1000) / 68_000 + 0.001, ORIGIN[1] + 0.001],
        },
      ],
    )
    expect(net.neighbours.get('23#1')).toEqual(['80#1'])
    expect(net.neighbours.get('23#0') ?? []).toEqual([])
  })

  it('collapses the arms of one junction into one vertex', () => {
    const net = buildNetwork(
      [node('45', 0, 0), node('45', 30, 10), node('45', -20, 25), node('46', 2000, 0)],
      [leg('45', '46', 2.2)],
    )
    expect([...net.at.keys()].sort()).toEqual(['45', '46'])
    expect(metresBetween(net.at.get('45')!, ORIGIN)).toBeLessThan(30)
  })

  it('can strike a leg out again', () => {
    const net = withoutLeg(grid(), '00', '01')
    expect(net.neighbours.get('00')).toEqual(['10'])
    expect(net.neighbours.get('01')).not.toContain('00')
    expect(net.legs.has(legKey('00', '01'))).toBe(false)
  })
})

describe('planning a ride along the legs', () => {
  // The whole point: standing at a junction, the signs only offer its
  // neighbours, so every consecutive pair in the plan must be a real leg.
  it('produces a ride whose every step is a signed leg', () => {
    const net = grid()
    const loop = findNodeLoop(net, '00', 6, { random: seeded() })!.plan

    expect(loop[0]).toBe('00')
    expect(loop[loop.length - 1]).toBe('00')
    for (let i = 0; i < loop.length - 1; i++) {
      expect(net.neighbours.get(loop[i])).toContain(loop[i + 1])
    }
  })

  // Lengths are the legs' own, so the plan's idea of the distance is the
  // road's — not a straight line with a guess at the bends.
  it('lands near the length asked for, by the legs’ real lengths', () => {
    const net = grid()
    const loop = findNodeLoop(net, '00', 8.8, { random: seeded() })!.plan
    let km = 0
    for (let i = 0; i < loop.length - 1; i++) km += net.legs.get(legKey(loop[i], loop[i + 1]))!.km
    expect(km).toBeGreaterThan(7.2)
    expect(km).toBeLessThan(10.4)
  })

  // The first version closed at the first junction that would do, which on
  // a network of two-kilometre legs landed a 25 km ask a fifth short. A ride
  // now goes on past a chance to close unless it is already about right.
  it('rides on past an early chance to close when the target is further', () => {
    // On the grid every loop is an even number of 1.1 km legs: 8.8 or 11 km
    // straddle a 10 km ask, and the first is close enough to close on.
    const found = findNodeLoop(grid(), '00', 10, { random: seeded() })!
    expect(found.km).toBeCloseTo(11, 1)
  })

  it('never rides the same leg twice', () => {
    const net = grid()
    const loop = findNodeLoop(net, '00', 10, { random: seeded() })!.plan
    const legs = loop.slice(0, -1).map((a, i) => legKey(a, loop[i + 1]))
    expect(new Set(legs).size).toBe(legs.length)
  })

  // Forbidding repeated legs was not enough: the walk could run out to a
  // junction, go round from there and come back to it — a lollipop with a
  // stem. Riders notice; it does not read as a round trip.
  it('never visits a junction twice', () => {
    const net = grid(1200, 5)
    const plan = findNodeLoop(net, '00', 10, { random: seeded(4242), homeAt: ORIGIN })!.plan
    const middle = plan.slice(0, -1) // the closing junction repeats the first
    expect(new Set(middle).size).toBe(middle.length)
  })

  // Home sits on a leg: the way out to the nearest junction runs along it,
  // and a ride that then takes that leg comes straight back past the door.
  it('keeps the ride off the leg that runs past the doorstep', () => {
    // A 3x3 grid with the doorstep halfway along the leg from 00 to 01.
    const net = grid(1000, 3)
    const home = offset(ORIGIN, 500, 30)
    for (const seed of [1, 2, 3, 4, 5]) {
      const found = findNodeLoop(net, '00', 6.6, {
        random: seeded(seed),
        homeAt: home,
        finishes: new Set(['00', '01']),
        connectorKm: (id) => metresBetween(home, net.at.get(id)!) / 1000,
      })!
      const steps = found.plan.slice(0, -1).map((a, i) => legKey(a, found.plan[i + 1]))
      expect(steps).not.toContain(legKey('00', '01'))
    }
  })

  it('gives up where the network offers no ride near the target', () => {
    // Two junctions and one leg: the only closed walk rides it twice.
    const net = buildNetwork([node('1', 0, 0), node('2', 1000, 0)], [leg('1', '2', 1.1)])
    expect(findNodeLoop(net, '1', 5, { random: seeded() })).toBeNull()
  })

  // Nearest-junction-first sent the ride out to a junction behind the door
  // and straight back past it. An out-and-back is exactly as long as a round,
  // so length alone cannot tell them apart — shape has to be scored too.
  it('prefers a round over an out-and-back of the same length', () => {
    const ring: NetworkNode[] = []
    const legs: NetworkLeg[] = []
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      ring.push({
        ref: `r${i}`,
        lngLat: offset(ORIGIN, Math.round(Math.cos(a) * 2000), Math.round(Math.sin(a) * 2000)),
      })
      legs.push(leg(`r${i}`, `r${(i + 1) % 6}`, 2.2))
    }
    const net = buildNetwork(ring, legs)
    const found = findNodeLoop(net, 'r0', 13.2, { random: seeded(999), homeAt: ORIGIN })!

    expect(found.plan.length).toBeGreaterThan(4)
    expect(found.score).toBeLessThan(1)
  })
})

describe('stitching a leg out of its ways', () => {
  const A = ORIGIN
  const B = offset(ORIGIN, 1000, 0)
  const way = (role: string, ...points: LngLat[]): LegWay => ({ role, points })

  it('joins ways given in any order and either orientation', () => {
    const p1 = offset(A, 300, 0)
    const p2 = offset(A, 600, 0)
    const line = stitchLeg(
      [way('', B, p2), way('', A, p1), way('', p2, p1)], // shuffled, two reversed
      A,
      B,
    )!
    expect(line.map((p) => Math.round(metresBetween(A, p)))).toEqual([0, 300, 600, 1000])
  })

  // Nearly half the legs measured carry forward/backward members: a path on
  // each side of the road, each ridden one way. From A to B that is the
  // forward side; the backward one is the way home.
  it('rides the side of a split path that runs its way', () => {
    const north = [offset(A, 300, 20), offset(A, 600, 20)]
    const south = [offset(A, 300, -20), offset(A, 600, -20)]
    // Both sides are drawn west to east; the role says which way each is
    // ridden — `backward` being against the way's own direction.
    const ways = [
      way('', A, offset(A, 300, 0)),
      way('forward', offset(A, 300, 0), ...north, offset(A, 700, 0)),
      way('backward', offset(A, 300, 0), ...south, offset(A, 700, 0)),
      way('', offset(A, 700, 0), B),
    ]
    const there = stitchLeg(ways, A, B)!
    expect(there.some((p) => metresBetween(p, north[0]) < 1)).toBe(true)
    expect(there.some((p) => metresBetween(p, south[0]) < 1)).toBe(false)

    // A backward member is ridden against its own direction: B to A takes
    // the other side.
    const back = stitchLeg(ways, B, A)!
    expect(back.some((p) => metresBetween(p, south[0]) < 1)).toBe(true)
    expect(back[0]).toEqual(B)
  })

  it('bridges a small gap between two ways', () => {
    const line = stitchLeg(
      [way('', A, offset(A, 490, 0)), way('', offset(A, 510, 0), B)],
      A,
      B,
    )!
    expect(line[0]).toEqual(A)
    expect(line[line.length - 1]).toEqual(B)
  })

  it('refuses a leg whose ways do not reach its junction', () => {
    expect(stitchLeg([way('', offset(A, 400, 0), B)], A, B)).toBeNull()
  })
})

describe('reading turns off a leg', () => {
  // Out east, a square corner north, a gentle kink, and a sharp hairpin.
  it('calls a corner a turn and leaves a gentle bend unsaid', () => {
    const line = [
      ORIGIN,
      offset(ORIGIN, 200, 0), // 90° left here, onto the northbound stretch
      offset(ORIGIN, 200, 200),
      offset(ORIGIN, 230, 400), // ~8° right: a bend, not a turn
      offset(ORIGIN, 260, 600), // sharp left, ~140°
      offset(ORIGIN, 110, 474),
    ]
    const hints = turnHintsAlong(line, 0, line.length - 1)
    expect(hints.map((h) => [h[0], h[1]])).toEqual([
      [1, 2], // left
      [4, 4], // sharp left
    ])
    expect(hints[0][4]).toBeLessThan(0) // left is negative, as BRouter has it
  })

  // Mapped curves arrive as many short segments; measured vertex to vertex
  // each would be a turn. Taken over a few metres, a curve is a curve.
  it('does not mistake a curve drawn in small steps for turns', () => {
    const line: LngLat[] = []
    for (let a = 0; a <= 90; a += 5) {
      const r = (a * Math.PI) / 180
      line.push(offset(ORIGIN, Math.sin(r) * 300, (1 - Math.cos(r)) * 300))
    }
    expect(turnHintsAlong(line, 0, line.length - 1)).toEqual([])
  })
})

describe('placing the numbers on the finished line', () => {
  // A square loop out east, north, back west, south to the start.
  const square = () => {
    const pts: LngLat[] = []
    for (let m = 0; m <= 1000; m += 50) pts.push(offset(ORIGIN, m, 0))
    for (let m = 50; m <= 1000; m += 50) pts.push(offset(ORIGIN, 1000, m))
    for (let m = 950; m >= 0; m -= 50) pts.push(offset(ORIGIN, m, 1000))
    for (let m = 950; m >= 0; m -= 50) pts.push(offset(ORIGIN, 0, m))
    return pts
  }

  it('measures how far along each junction sits', () => {
    const stops = stopsForPlan(square(), [node('12', 1000, 0), node('78', 1000, 1000)])
    expect(stops.map((s) => s.ref)).toEqual(['12', '78'])
    expect(stops[0].atKm).toBeCloseTo(1, 1)
    expect(stops[1].atKm).toBeCloseTo(2, 1)
  })

  // The finish of a round trip sits on its start, so the junction there is
  // genuinely passed twice — and the second sighting belongs at the end.
  it('puts the closing junction at the end, not back at the start', () => {
    const stops = stopsForPlan(square(), [node('12', 0, 0), node('78', 1000, 1000), node('12', 0, 0)])
    expect(stops[0].atKm).toBeCloseTo(0, 1)
    expect(stops[2].atKm).toBeCloseTo(4, 1)
  })
})

describe('junctions a connector rides through', () => {
  it('names them in order, and only those on the line', () => {
    const net = grid()
    // Straight east along the bottom row, 20 m south of the junctions.
    const line = [offset(ORIGIN, -500, -20), offset(ORIGIN, 2500, -20)]
    const passed = junctionsAlong(line, net)
    expect(passed.map((j) => j.id)).toEqual(['00', '01', '02'])
    expect(passed[1].atKm).toBeCloseTo(1.5, 1)
  })
})

describe('where the switch is offered', () => {
  it('knows the Low Countries from the rest of the world', () => {
    expect(inNetworkCountries([4.3, 52.1])).toBe(true) // Den Haag
    expect(inNetworkCountries([4.35, 50.85])).toBe(true) // Brussel
    expect(inNetworkCountries([139.69, 35.69])).toBe(false) // Tokyo
    expect(inNetworkCountries([-0.13, 51.5])).toBe(false) // London
  })
})
