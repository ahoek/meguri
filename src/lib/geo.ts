/**
 * A [longitude, latitude] pair. Route geometry from BRouter carries an
 * elevation as a third element, which the rest tuple absorbs.
 */
export type LngLat = [number, number, ...number[]]

const R = 6371 // earth radius, km
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Destination point given start [lng, lat], bearing (deg) and distance (km). */
export function destination([lng, lat]: LngLat, bearing: number, distKm: number): LngLat {
  const δ = distKm / R
  const θ = rad(bearing)
  const φ1 = rad(lat)
  const λ1 = rad(lng)
  const φ2 = Math.asin(
    Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ),
  )
  const λ2 =
    λ1 +
    Math.atan2(
      Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
      Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2),
    )
  return [((deg(λ2) + 540) % 360) - 180, deg(φ2)]
}

/** Great-circle distance in km between two [lng, lat] points. */
export function distanceKm([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const φ1 = rad(lat1)
  const φ2 = rad(lat2)
  const Δφ = rad(lat2 - lat1)
  const Δλ = rad(lng2 - lng1)
  const a =
    Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

/**
 * Via-points for a loop: the start sits on a circle of radius r whose center
 * lies at `bearing` from the start. The other points are spread around that
 * same circle, walked clockwise or counter-clockwise.
 */
export function loopViaPoints(
  start: LngLat,
  radiusKm: number,
  bearing: number,
  clockwise: boolean,
  count = 3,
): LngLat[] {
  const center = destination(start, bearing, radiusKm)
  const startAngle = bearing + 180 // angle of the start, seen from the center
  const dir = clockwise ? 1 : -1
  const step = 360 / (count + 1)
  const points: LngLat[] = []
  for (let i = 1; i <= count; i++) {
    points.push(destination(center, startAngle + dir * step * i, radiusKm))
  }
  return points
}

/** Initial bearing (deg) from a to b. */
export function bearingBetween([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const φ1 = rad(lat1)
  const φ2 = rad(lat2)
  const Δλ = rad(lng2 - lng1)
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return (deg(Math.atan2(y, x)) + 360) % 360
}

/** Centroid of [lng, lat] points — plenty accurate at loop scale. */
function centroid(points: LngLat[]): LngLat {
  const sum = points.reduce((s, p) => [s[0] + p[0], s[1] + p[1]], [0, 0])
  return [sum[0] / points.length, sum[1] / points.length]
}

/**
 * Via-points for a loop that must pass through the user's waypoints. The
 * circle is pinned to the centroid of start + waypoints; `count` generated
 * points at `radiusKm` fill the angular gaps (rotated by `phase` so retries
 * can try new terrain), and everything is ordered by angle around the centre
 * so the loop goes round rather than zigzagging. The start is not included.
 */
export function loopViaWithWaypoints(
  start: LngLat,
  waypoints: LngLat[],
  radiusKm: number,
  phase: number,
  clockwise: boolean,
  count: number,
): LngLat[] {
  const center = centroid([start, ...waypoints])
  const dir = clockwise ? 1 : -1
  const startAngle = bearingBetween(center, start)
  // Angle walked from the start, in the travel direction: 0..360.
  const angleOf = (p: LngLat) => (((bearingBetween(center, p) - startAngle) * dir) % 360 + 360) % 360

  const points = waypoints.map((p) => ({ point: p, angle: angleOf(p) }))
  const step = 360 / (count + 1)
  const gap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b))
  for (let i = 1; i <= count; i++) {
    const angle = (step * i + phase) % 360
    // A generated point next to the start or a waypoint adds no shape,
    // only an extra forced detour.
    if (gap(angle, 0) < step * 0.4) continue
    if (points.some((f) => gap(f.angle, angle) < step * 0.4)) continue
    points.push({
      point: destination(center, startAngle + dir * angle, radiusKm),
      angle,
    })
  }
  return points.sort((a, b) => a.angle - b.angle).map((entry) => entry.point)
}
