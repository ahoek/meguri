import { prepareRoute } from '../src/domain/navigation'
import type { LngLat } from '../src/domain/geo'
import type { Route, VoiceHint } from '../src/domain/route'

// Around 52°N a degree of longitude is ~68 km and of latitude ~111 km.
export const M_PER_DEG_LNG = 68000
export const M_PER_DEG_LAT = 111000

export const ORIGIN: LngLat = [4.8945, 52.3667] // Amsterdam

/** Offset a point by metres east and north. */
export function offset([lng, lat]: LngLat, eastM: number, northM: number): LngLat {
  return [lng + eastM / M_PER_DEG_LNG, lat + northM / M_PER_DEG_LAT]
}

export function metresBetween(a: LngLat, b: LngLat): number {
  return Math.hypot((a[0] - b[0]) * M_PER_DEG_LNG, (a[1] - b[1]) * M_PER_DEG_LAT)
}

/** A route from leg descriptions: { east, north } offsets in metres. */
export function routeFrom(
  legs: { east?: number; north?: number }[],
  { voicehints = [] as VoiceHint[] } = {},
): Route {
  const coords: LngLat[] = [ORIGIN]
  for (const leg of legs) {
    coords.push(offset(coords[coords.length - 1], leg.east ?? 0, leg.north ?? 0))
  }
  return {
    geometry: { type: 'LineString', coordinates: coords },
    distanceKm: 0,
    durationSec: 0,
    voicehints,
  }
}

/**
 * A square loop that returns to its start — the shape that caused the
 * false-arrival bug, since the finish sits exactly on the start.
 */
export function squareLoop(sideM = 400, step = 20): Route {
  const coords: LngLat[] = []
  const push = (p: LngLat) => {
    if (!coords.length || metresBetween(coords[coords.length - 1], p) > 0.01) {
      coords.push(p)
    }
  }
  let here = ORIGIN
  push(here)
  const legs = [
    { east: 0, north: 1 },
    { east: 1, north: 0 },
    { east: 0, north: -1 },
    { east: -1, north: 0 },
  ]
  for (const dir of legs) {
    for (let travelled = 0; travelled < sideM; travelled += step) {
      here = offset(here, dir.east * step, dir.north * step)
      push(here)
    }
  }
  return {
    geometry: { type: 'LineString', coordinates: coords },
    distanceKm: 0,
    durationSec: 0,
    voicehints: [],
  }
}

export const prepared = (route: Route) => prepareRoute(route)
