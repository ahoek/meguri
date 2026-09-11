import maplibregl from 'maplibre-gl'
import type { Route } from '../domain/route'

/**
 * The route as a picture, for paper.
 *
 * Not a screenshot of the map on screen: that one is framed for a phone with
 * a sheet over half of it. A second map is drawn offscreen at the panel's
 * own size, the route and its numbers painted on as layers (markers are DOM
 * and never reach the canvas), and the canvas read out once the tiles have
 * settled. The second map is thrown away at once.
 */

const STYLE = 'https://tiles.openfreemap.org/styles/liberty'
const GREEN = '#047857'
const ROUTE = '#7c3aed'

export async function renderRouteMap(
  route: Route,
  { width, height, pixelRatio = 2 }: { width: number; height: number; pixelRatio?: number },
): Promise<string> {
  const container = document.createElement('div')
  container.style.cssText = `position:fixed;left:-${width + 100}px;top:0;width:${width}px;height:${height}px;`
  document.body.appendChild(container)

  const coords = route.geometry.coordinates
  const bounds = coords.reduce(
    (b, [lng, lat]) => b.extend([lng, lat]),
    new maplibregl.LngLatBounds([coords[0][0], coords[0][1]], [coords[0][0], coords[0][1]]),
  )

  const map = new maplibregl.Map({
    container,
    style: STYLE,
    bounds,
    fitBoundsOptions: { padding: 40 },
    interactive: false,
    attributionControl: false,
    pixelRatio,
    // Read back after drawing, which WebGL forgets by default.
    canvasContextAttributes: { preserveDrawingBuffer: true },
    fadeDuration: 0,
  })

  try {
    await new Promise<void>((resolve, reject) => {
      map.once('load', () => resolve())
      map.once('error', (e) => reject(e.error ?? new Error('map failed')))
    })

    map.addSource('print-route', {
      type: 'geojson',
      data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} },
    })
    map.addLayer({
      id: 'print-route-casing',
      type: 'line',
      source: 'print-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': '#ffffff', 'line-width': 9 },
    })
    map.addLayer({
      id: 'print-route-line',
      type: 'line',
      source: 'print-route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ROUTE, 'line-width': 5 },
    })

    const junctions = route.junctions ?? []
    map.addSource('print-junctions', {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          ...junctions.map((j) => ({
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: j.lngLat },
            properties: { ref: j.ref, kind: 'junction' },
          })),
          {
            type: 'Feature' as const,
            geometry: { type: 'Point' as const, coordinates: coords[0] },
            properties: { ref: '', kind: 'start' },
          },
        ],
      },
    })
    map.addLayer({
      id: 'print-junction-badge',
      type: 'circle',
      source: 'print-junctions',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'kind'], 'start'], 7, 11],
        'circle-color': ['case', ['==', ['get', 'kind'], 'start'], ROUTE, '#ffffff'],
        'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'start'], '#ffffff', GREEN],
        'circle-stroke-width': 2.5,
      },
    })
    map.addLayer({
      id: 'print-junction-number',
      type: 'symbol',
      source: 'print-junctions',
      layout: {
        'text-field': ['get', 'ref'],
        'text-size': 12,
        'text-font': ['Noto Sans Bold'],
        // Every number prints, whatever the crowding: the strip beside the
        // map is where they are read in order; here they mark the places.
        'text-allow-overlap': true,
        'text-ignore-placement': true,
      },
      paint: { 'text-color': GREEN },
    })

    await new Promise<void>((resolve) => map.once('idle', () => resolve()))
    return map.getCanvas().toDataURL('image/png')
  } finally {
    map.remove()
    container.remove()
  }
}
