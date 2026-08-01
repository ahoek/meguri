import { prepareRoute } from '../src/lib/navigation.js'

// Around 52°N a degree of longitude is ~68 km and of latitude ~111 km.
export const M_PER_DEG_LNG = 68000
export const M_PER_DEG_LAT = 111000

export const ORIGIN = [4.8945, 52.3667] // Amsterdam

/** Offset a point by metres east and north. */
export function offset([lng, lat], eastM, northM) {
  return [lng + eastM / M_PER_DEG_LNG, lat + northM / M_PER_DEG_LAT]
}

export function metresBetween(a, b) {
  return Math.hypot((a[0] - b[0]) * M_PER_DEG_LNG, (a[1] - b[1]) * M_PER_DEG_LAT)
}

/** A route from leg descriptions: { east, north } offsets in metres. */
export function routeFrom(legs, { voicehints = [] } = {}) {
  const coords = [ORIGIN]
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
export function squareLoop(sideM = 400, step = 20) {
  const coords = []
  const push = (p) => {
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

export const prepared = (route) => prepareRoute(route)
