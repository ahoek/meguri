import { describe, expect, it } from 'vitest'
import {
  nodesAlongRoute,
  buildNetwork,
  findNodeLoop,
} from '../src/domain/knooppunten'
import { ORIGIN, offset, metresBetween } from './helpers'
import type { NetworkNode, NetworkLeg } from '../src/domain/knooppunten'

const node = (ref: string, east: number, north: number): NetworkNode => ({
  ref,
  lngLat: offset(ORIGIN, east, north),
})

describe('reading the sequence back off the finished loop', () => {
  // A square loop out east, north, back west, south to the start.
  const square = () => {
    const pts = []
    for (let m = 0; m <= 1000; m += 50) pts.push(offset(ORIGIN, m, 0))
    for (let m = 50; m <= 1000; m += 50) pts.push(offset(ORIGIN, 1000, m))
    for (let m = 950; m >= 0; m -= 50) pts.push(offset(ORIGIN, m, 1000))
    for (let m = 950; m >= 0; m -= 50) pts.push(offset(ORIGIN, 0, m))
    return pts
  }

  it('lists the junctions in the order they are ridden', () => {
    const nodes = [
      node('78', 1000, 1000), // third corner
      node('12', 1000, 0), // second corner
      node('45', 0, 1000), // fourth corner
    ]
    const stops = nodesAlongRoute(square(), nodes)
    expect(stops.map((s) => s.ref)).toEqual(['12', '78', '45'])
  })

  it('ignores junctions the loop does not actually reach', () => {
    const stops = nodesAlongRoute(square(), [node('99', 500, 500)]) // mid-field
    expect(stops).toEqual([])
  })

  // The finish of a round trip sits on its start, so the junction there is
  // genuinely passed twice and belongs in the sequence twice.
  it('reports a junction at the start and again at the finish', () => {
    const stops = nodesAlongRoute(square(), [node('12', 0, 0)])
    expect(stops.map((s) => s.ref)).toEqual(['12', '12'])
    expect(stops[1].atKm - stops[0].atKm).toBeGreaterThan(3)
  })
})

describe('completeness of the sequence', () => {
  // Route vertices can sit hundreds of metres apart on a straight. Measuring
  // to the nearest vertex rather than to the line hid a junction 23 m from a
  // real loop, which is exactly the kind of gap that makes a numbered route
  // untrustworthy.
  it('finds a junction beside a long segment with no vertex near it', () => {
    const line = [ORIGIN, offset(ORIGIN, 1000, 0)] // one 1 km leg, two vertices
    const beside = node('33', 500, 20) // 20 m off the line, 500 m from either end

    const stops = nodesAlongRoute(line, [beside])
    expect(stops.map((s) => s.ref)).toEqual(['33'])
    expect(stops[0].atKm).toBeCloseTo(0.5, 1)
  })

  it('still leaves out what the loop genuinely passes wide of', () => {
    const line = [ORIGIN, offset(ORIGIN, 1000, 0)]
    expect(nodesAlongRoute(line, [node('99', 500, 300)])).toEqual([])
  })
})

describe('planning a ride along the legs', () => {
  // A 4x4 grid of junctions, numbered r0c0 style, joined only to their
  // orthogonal neighbours — a small stand-in for a real network.
  const grid = (spacingM = 1000) => {
    const nodes: NetworkNode[] = []
    const legs: NetworkLeg[] = []
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        nodes.push({ ref: `${r}${c}`, lngLat: offset(ORIGIN, c * spacingM, r * spacingM) })
        if (c) legs.push({ a: `${r}${c - 1}`, b: `${r}${c}` })
        if (r) legs.push({ a: `${r - 1}${c}`, b: `${r}${c}` })
      }
    }
    return buildNetwork(nodes, legs)
  }

  // Deterministic, so a failure is reproducible.
  const seeded = () => {
    let s = 12345
    return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  }

  it('joins each junction only to its real neighbours', () => {
    const net = grid()
    expect(net.neighbours.get('00')!.sort()).toEqual(['01', '10'])
    expect(net.neighbours.get('11')!.sort()).toEqual(['01', '10', '12', '21'])
  })

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

  it('lands near the length asked for', () => {
    const net = grid()
    const loop = findNodeLoop(net, '00', 8, { random: seeded() })!.plan
    let km = 0
    for (let i = 0; i < loop.length - 1; i++) {
      km += metresBetween(net.at.get(loop[i])!, net.at.get(loop[i + 1])!) / 1000
    }
    expect(km).toBeGreaterThan(5)
    expect(km).toBeLessThan(11)
  })

  it('never rides the same leg twice', () => {
    const net = grid()
    const loop = findNodeLoop(net, '00', 10, { random: seeded() })!.plan
    const legs = loop.slice(0, -1).map((a, i) => [a, loop[i + 1]].sort().join('|'))
    expect(new Set(legs).size).toBe(legs.length)
  })

  // A number reused far away is a different junction in another region's
  // numbering, and a bare ref cannot tell them apart.
  // Neighbouring regions each number from 1, so one query around a town
  // returns several junctions with the same number. Dropping them gutted the
  // graph — 77 of 105 numbers went, leaving too few legs to plan a ride. Both
  // survive now, and the leg attaches to whichever pair the sign can mean.
  it('keeps both when a number is reused in the next region', () => {
    const near = offset(ORIGIN, 1000, 0)
    const faraway = offset(ORIGIN, 30_000, 0)
    const net = buildNetwork(
      [
        { ref: '7', lngLat: ORIGIN },
        { ref: '7', lngLat: faraway },
        { ref: '8', lngLat: near },
      ],
      [{ a: '7', b: '8' }],
    )

    expect([...net.at.keys()].sort()).toEqual(['7#0', '7#1', '8'])
    // The leg joins 8 to the 7 beside it, not the one thirty kilometres away.
    expect(net.neighbours.get('8')).toEqual(['7#0'])
    expect(net.neighbours.get('7#1') ?? []).toEqual([])
  })
})

describe('the shape of the ride', () => {
  // Nearest-junction-first sent the ride out to a junction behind the door
  // and straight back past it. An out-and-back is exactly as long as a round,
  // so length alone cannot tell them apart — shape has to be scored too.
  it('prefers a round over an out-and-back of the same length', () => {
    // A ring of six junctions, plus a spur hanging off the first.
    const ring: NetworkNode[] = []
    const legs: NetworkLeg[] = []
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2
      ring.push({
        ref: `r${i}`,
        lngLat: offset(ORIGIN, Math.round(Math.cos(a) * 2000), Math.round(Math.sin(a) * 2000)),
      })
      legs.push({ a: `r${i}`, b: `r${(i + 1) % 6}` })
    }
    const net = buildNetwork(ring, legs)

    const seeded = () => {
      let s = 999
      return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    }
    // Six 2 km sides, and legs are estimated with a bend allowance, so the
    // whole ring is about 15 km — ask for that.
    const found = findNodeLoop(net, 'r0', 15, { random: seeded(), homeAt: ORIGIN })!

    // Going right round the ring is the round; the score rewards it.
    expect(found.plan.length).toBeGreaterThan(4)
    expect(found.score).toBeLessThan(1)
  })
})

describe('a loop is a loop', () => {
  // Forbidding repeated legs was not enough: the walk could run out to a
  // junction, go round from there and come back to it — a lollipop with a
  // stem. Riders notice; it does not read as a round trip.
  it('never visits a junction twice', () => {
    const nodes: NetworkNode[] = []
    const legs: NetworkLeg[] = []
    for (let r = 0; r < 5; r++) {
      for (let c = 0; c < 5; c++) {
        nodes.push({ ref: `${r}${c}`, lngLat: offset(ORIGIN, c * 1200, r * 1200) })
        if (c) legs.push({ a: `${r}${c - 1}`, b: `${r}${c}` })
        if (r) legs.push({ a: `${r - 1}${c}`, b: `${r}${c}` })
      }
    }
    const net = buildNetwork(nodes, legs)
    let seed = 4242
    const random = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

    const plan = findNodeLoop(net, '00', 10, { random, homeAt: ORIGIN })!.plan
    const middle = plan.slice(0, -1) // the closing junction repeats the first
    expect(new Set(middle).size).toBe(middle.length)
  })
})
