import maplibregl from 'maplibre-gl'
import type { LngLat } from '../domain/geo'
import type { Profile } from '../domain/route'

/**
 * The three lines: the route, the part of it already covered, and the dashed
 * way back after a wrong turn. Owns their sources, layers and widths.
 */

export const EMPTY = { type: 'FeatureCollection' as const, features: [] }

// Route coordinates may carry elevation; MapLibre wants a bare pair.
export const ll = ([lng, lat]: LngLat): [number, number] => [lng, lat]

export function lineFeature(coordinates: LngLat[]) {
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'LineString' as const, coordinates },
  }
}

const GRADIENTS: Record<Profile, [string, string]> = {
  walk: ['#059669', '#84cc16'],
  bike: ['#6366f1', '#ec4899'],
}

function lineGradient(mode: Profile): maplibregl.ExpressionSpecification {
  const [from, to] = GRADIENTS[mode]
  return ['interpolate', ['linear'], ['line-progress'], 0, from, 1, to]
}

// A path you can walk two abreast on. Drawn to that width on the ground
// rather than to a pixel count, so it reads as a real path at every zoom
// instead of a ribbon that swallows the street when you zoom in.
const PATH_WIDTH_M = 1.5
const CASING_WIDTH_M = 2.3
const EQUATOR_M_PER_PX = 156543.03392 // at zoom 0, 256 px tiles

/**
 * Line width held constant on the ground.
 *
 * Metres per pixel halve with every zoom level, so a fixed ground width
 * doubles — which is exactly what an exponential-base-2 interpolation between
 * two stops produces. Below `minPx` the line would be thinner than a hairline
 * and the loop would vanish from the planner, so it flattens out there.
 */
export function groundWidth(metres: number, lat: number, minPx: number) {
  const perPx = EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)
  const pxAt = (zoom: number) => (metres * Math.pow(2, zoom)) / perPx
  // The zoom at which the true width overtakes the floor.
  const pinned = Math.log2((minPx * perPx) / metres)
  return [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    0,
    minPx,
    pinned,
    minPx,
    22,
    pxAt(22),
  ] as maplibregl.ExpressionSpecification
}

export function createRouteLayers(map: maplibregl.Map) {
  const source = (id: string) =>
    map.getSource(id) as maplibregl.GeoJSONSource | undefined

  return {
    /** Called once the style has loaded. */
    add(mode: Profile, lat: number) {
      map.addSource('route', { type: 'geojson', data: EMPTY, lineMetrics: true })
      map.addLayer({
        id: 'route-casing',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#ffffff',
          'line-width': groundWidth(CASING_WIDTH_M, lat, 8),
          'line-opacity': 0.9,
        },
      })
      map.addLayer({
        id: 'route-line',
        type: 'line',
        source: 'route',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-width': groundWidth(PATH_WIDTH_M, lat, 5),
          'line-gradient': lineGradient(mode),
        },
      })

      // Path back to the loop after a wrong turn.
      map.addSource('rejoin', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'rejoin-line',
        type: 'line',
        source: 'rejoin',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#f59e0b',
          'line-width': groundWidth(PATH_WIDTH_M, lat, 4),
          'line-dasharray': [1.6, 1.2],
        },
      })

      // Drawn over the route while navigating, greying out what's behind you.
      map.addSource('traveled', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'traveled-line',
        type: 'line',
        source: 'traveled',
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: 'none' },
        paint: {
          'line-color': '#94a3b8',
          'line-width': groundWidth(PATH_WIDTH_M, lat, 5),
          'line-opacity': 0.85,
        },
      })
    },

    ready() {
      return !!map.getSource('route')
    },

    setGradient(mode: Profile) {
      if (map.getLayer('route-line')) {
        map.setPaintProperty('route-line', 'line-gradient', lineGradient(mode))
      }
    },

    /** Metres per pixel depend on latitude, so widths follow the loop. */
    applyWidths(lat: number) {
      const line = groundWidth(PATH_WIDTH_M, lat, 5)
      if (map.getLayer('route-line')) map.setPaintProperty('route-line', 'line-width', line)
      if (map.getLayer('route-casing')) {
        map.setPaintProperty('route-casing', 'line-width', groundWidth(CASING_WIDTH_M, lat, 8))
      }
      if (map.getLayer('traveled-line')) {
        map.setPaintProperty('traveled-line', 'line-width', line)
      }
      if (map.getLayer('rejoin-line')) {
        map.setPaintProperty('rejoin-line', 'line-width', groundWidth(PATH_WIDTH_M, lat, 4))
      }
    },

    setRoute(coords: LngLat[]) {
      source('route')?.setData(lineFeature(coords))
    },

    clearRoute() {
      source('route')?.setData(EMPTY)
    },

    setTraveled(coords: LngLat[]) {
      source('traveled')?.setData(lineFeature(coords))
    },

    setRejoin(coords: LngLat[] | null) {
      source('rejoin')?.setData(coords ? lineFeature(coords) : EMPTY)
    },

    showTraveled(visible: boolean) {
      map.setLayoutProperty('traveled-line', 'visibility', visible ? 'visible' : 'none')
    },

    clearNavigationLines() {
      source('rejoin')?.setData(EMPTY)
      source('traveled')?.setData(EMPTY)
    },

    boundsOf(coords: LngLat[]) {
      return coords.reduce(
        (b, c) => b.extend(ll(c)),
        new maplibregl.LngLatBounds(ll(coords[0]), ll(coords[0])),
      )
    },
  }
}
