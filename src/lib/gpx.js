import { t } from '../i18n.js'

export function downloadGpx(route, mode) {
  const points = route.geometry.coordinates
    .map(([lng, lat, ele]) => {
      const pos = `lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"`
      return ele != null
        ? `      <trkpt ${pos}><ele>${ele}</ele></trkpt>`
        : `      <trkpt ${pos}/>`
    })
    .join('\n')
  const kind = t(mode === 'bike' ? 'gpxRide' : 'gpxWalk')
  const name = `Meguri ${kind} — ${route.distanceKm.toFixed(1)} km`
  const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Meguri" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`
  const blob = new Blob([gpx], { type: 'application/gpx+xml' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `meguri-${route.distanceKm.toFixed(1)}km.gpx`
  a.click()
  URL.revokeObjectURL(url)
}
