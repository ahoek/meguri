import { describe, expect, it, vi } from 'vitest'
import { ORIGIN, offset, metresBetween } from './helpers.js'

// route.js reaches for BRouter as soon as it is asked to route; these tests
// only exercise the shaping it does to the answer.
async function loadRoute() {
  vi.resetModules()
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
  return import('../src/lib/route.js')
}

function brouterResponse(coordinates, voicehints = []) {
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
async function routeThrough(coordinates, voicehints) {
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
