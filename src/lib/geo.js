const R = 6371 // earth radius, km
const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI

/** Destination point given start [lng, lat], bearing (deg) and distance (km). */
export function destination([lng, lat], bearing, distKm) {
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
export function distanceKm([lng1, lat1], [lng2, lat2]) {
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
export function loopViaPoints(start, radiusKm, bearing, clockwise, count = 3) {
  const center = destination(start, bearing, radiusKm)
  const startAngle = bearing + 180 // angle of the start, seen from the center
  const dir = clockwise ? 1 : -1
  const step = 360 / (count + 1)
  const points = []
  for (let i = 1; i <= count; i++) {
    points.push(destination(center, startAngle + dir * step * i, radiusKm))
  }
  return points
}
