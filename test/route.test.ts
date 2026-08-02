import { describe, expect, it, vi } from 'vitest'
import { ORIGIN, offset, metresBetween } from './helpers'
import type { LngLat } from '../src/lib/geo'
import type { VoiceHint } from '../src/lib/route'

// route.js reaches for BRouter as soon as it is asked to route; these tests
// only exercise the shaping it does to the answer.
async function loadRoute() {
  vi.resetModules()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  return import('../src/lib/route')
}

function brouterResponse(coordinates: LngLat[], voicehints: VoiceHint[] = []) {
  return {
    features: [
      {
        geometry: { type: 'LineString', coordinates },
        properties: {
          'track-length': '1000',
          'total-time': '300',
          voicehints,
        },
      },
    ],
  }
}

/** Drive one generateLoop attempt and capture what it produced. */
async function routeThrough(coordinates: LngLat[], voicehints: VoiceHint[] = []) {
  const mod = await loadRoute()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify(brouterResponse(coordinates, voicehints)), {
        status: 200,
      }),
    ),
  )
  return mod.generateLoop({
    start: ORIGIN,
    targetKm: 1,
    profile: 'bike',
    nature: false,
    bearing: 0,
    clockwise: true,
  })
}

describe('trimming out-and-back spurs', () => {
  // A dead-end tip doubles back on itself: A → T → A. Riding it means
  // covering the same road twice, so it comes out of the line.
  const withSpur = () => {
    const a = ORIGIN
    const b = offset(a, 0, 100)
    const tip = offset(b, 60, 0)
    const c = offset(b, 0, 100)
    return { coords: [a, b, tip, b, c], b }
  }

  it('removes the doubled-back tip', async () => {
    const { coords, b } = withSpur()
    const route = await routeThrough(coords)
    const out = route.geometry.coordinates

    expect(out).toHaveLength(3)
    expect(metresBetween(out[1], b)).toBeLessThan(1)
  })

  // Turn instructions index into the untrimmed point list, so they have to be
  // re-indexed or they point at the wrong places for the rest of the ride.
  it('re-indexes the turn instructions it keeps', async () => {
    const { coords } = withSpur()
    // A turn at point 4 (the final point) survives; one at the spur tip does not.
    const route = await routeThrough(coords, [
      [2, 2, 0, 0, 90], // on the tip — goes away with it
      [4, 5, 0, 0, 90], // on the last point — kept, but now at index 2
    ])

    expect(route.voicehints).toHaveLength(1)
    expect(route.voicehints[0][0]).toBe(2)
    expect(route.voicehints[0][1]).toBe(5)
  })

  it('leaves a clean route untouched', async () => {
    const straight = [ORIGIN, offset(ORIGIN, 0, 100), offset(ORIGIN, 0, 200)]
    const route = await routeThrough(straight, [[1, 2, 0, 0, 90]])

    expect(route.geometry.coordinates).toHaveLength(3)
    expect(route.voicehints[0][0]).toBe(1)
  })
})

describe('scoring loop candidates', () => {
  // Backtracking weighs heavier than missing the target length: a loop half
  // a kilometre long-of-target must still beat an exact one that rides the
  // same road twice.
  it('prefers a clean loop over an exact one that doubles back', async () => {
    const mod = await loadRoute()

    const a = ORIGIN
    const b = offset(a, 0, 200)
    // Runs the a–b road in both directions (~16% of its length doubled),
    // but its reported length matches the 1 km target exactly.
    const doubled = [a, b, offset(b, 300, 0), offset(a, 300, 0), b, a]
    // No doubling, but half a kilometre over target.
    const clean = [a, offset(a, 0, 300), offset(a, 300, 300), offset(a, 300, 0), a]

    const response = (coordinates: LngLat[], lengthM: number) =>
      new Response(
        JSON.stringify({
          features: [
            {
              geometry: { type: 'LineString', coordinates },
              properties: {
                'track-length': String(lengthM),
                'total-time': '300',
                voicehints: [],
              },
            },
          ],
        }),
        { status: 200 },
      )

    const fetchMock = vi.fn(async () => response(clean, 1500))
    fetchMock.mockImplementationOnce(async () => response(doubled, 1000))
    vi.stubGlobal('fetch', fetchMock)

    const route = await mod.generateLoop({
      start: a,
      targetKm: 1,
      profile: 'bike',
      nature: false,
      bearing: 0,
      clockwise: true,
    })

    expect(route.geometry.coordinates).toHaveLength(clean.length)
    expect(route.distanceKm).toBeCloseTo(1.5)
  })
})

describe('waypoints', () => {
  it('routes the loop through every user waypoint', async () => {
    const mod = await loadRoute()
    const urls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        urls.push(String(url))
        const square = [
          ORIGIN,
          offset(ORIGIN, 0, 300),
          offset(ORIGIN, 300, 300),
          offset(ORIGIN, 300, 0),
          ORIGIN,
        ]
        return new Response(JSON.stringify(brouterResponse(square)), { status: 200 })
      }),
    )

    const wp = offset(ORIGIN, 500, 500)
    await mod.generateLoop({
      start: ORIGIN,
      targetKm: 1,
      profile: 'bike',
      nature: false,
      bearing: 0,
      clockwise: true,
      waypoints: [wp],
    })

    expect(urls[0]).toContain(`${wp[0].toFixed(6)},${wp[1].toFixed(6)}`)
  })
})
