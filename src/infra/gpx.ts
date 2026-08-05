import type { Route } from '../domain/route'

const escapeXml = (s: string) =>
  s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))

/** `kind` is the translated activity name for the track title. */
export function gpxDocument(route: Route, kind: string) {
  const points = route.geometry.coordinates
    .map(([lng, lat, ele]) => {
      const pos = `lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}"`
      return ele != null
        ? `      <trkpt ${pos}><ele>${ele}</ele></trkpt>`
        : `      <trkpt ${pos}/>`
    })
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Meguri" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${escapeXml(trackName(route, kind))}</name>
    <trkseg>
${points}
    </trkseg>
  </trk>
</gpx>
`
}

const trackName = (route: Route, kind: string) =>
  `Meguri ${kind} — ${route.distanceKm.toFixed(1)} km`

const fileName = (route: Route) => `meguri-${route.distanceKm.toFixed(1)}km.gpx`

const GPX_TYPE = 'application/gpx+xml'

/**
 * Whether the phone will offer a share sheet rather than a silent download.
 *
 * Asked once: it is a question about the browser, and the answer cannot change
 * between one tap and the next.
 */
let shareable: boolean | null = null
export function canShareGpx() {
  if (shareable == null) {
    try {
      const probe = new File([''], 'probe.gpx', { type: GPX_TYPE })
      shareable = !!navigator.share && !!navigator.canShare?.({ files: [probe] })
    } catch {
      shareable = false
    }
  }
  return shareable
}

/**
 * Hand the loop to the phone.
 *
 * A download drops the file into Downloads with no obvious next thing to do
 * with it. The share sheet is where the file becomes useful: Save to Files,
 * AirDrop, and — the reason this exists — every route app on the phone, which
 * is also how the loop reaches a watch or a bike's head unit. Those are not
 * three integrations, they are this one file.
 *
 * Must be called straight from the tap: iOS refuses a share that arrives after
 * an await, so the file is built synchronously before anything is asked for.
 */
export async function shareGpx(route: Route, kind: string) {
  const gpx = gpxDocument(route, kind)
  if (canShareGpx()) {
    const file = new File([gpx], fileName(route), { type: GPX_TYPE })
    try {
      await navigator.share({ files: [file], title: trackName(route, kind) })
      return
    } catch (err) {
      // Closing the sheet is an answer. Posting the file to Downloads as a
      // consolation prize would be handing over the thing they just declined.
      if ((err as Error)?.name === 'AbortError') return
      // Anything else — a target that refused it, a permission quirk — still
      // leaves the walker wanting their route, so fall through to the file.
    }
  }
  download(gpx, fileName(route))
}

function download(gpx: string, name: string) {
  const url = URL.createObjectURL(new Blob([gpx], { type: GPX_TYPE }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  URL.revokeObjectURL(url)
}
