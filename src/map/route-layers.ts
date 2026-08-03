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

/**
 * A chevron pointing along the line, drawn rather than shipped as a sprite —
 * one icon isn't worth an asset pipeline, and generating it means the outline
 * and the fill stay in step with the width constants above.
 *
 * `symbol-placement: line` rotates an icon so its +x axis follows the line, so
 * this points right.
 */
const ARROW_PX = 30

function arrowImage(): maplibregl.StyleImageInterface | ImageData {
  const canvas = document.createElement('canvas')
  canvas.width = ARROW_PX
  canvas.height = ARROW_PX
  const g = canvas.getContext('2d')!
  const s = ARROW_PX
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.beginPath()
  g.moveTo(s * 0.33, s * 0.22)
  g.lineTo(s * 0.7, s * 0.5)
  g.lineTo(s * 0.33, s * 0.78)
  // Dark under, white over: legible against both halves of either gradient,
  // and against the grey of the stretch already ridden.
  g.strokeStyle = 'rgba(15, 23, 42, 0.45)'
  g.lineWidth = s * 0.26
  g.stroke()
  g.strokeStyle = '#ffffff'
  g.lineWidth = s * 0.13
  g.stroke()
  return g.getImageData(0, 0, ARROW_PX, ARROW_PX)
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

      // The gap between where you are standing and where that path begins.
      // Deliberately a different animal from the path itself — round dots, no
      // casing, half opacity — because it is a straight line across whatever
      // happens to be in the way and must not be mistaken for a route.
      map.addSource('rejoin-leader', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'rejoin-leader',
        type: 'line',
        source: 'rejoin-leader',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': '#f59e0b',
          'line-width': 3.5,
          'line-opacity': 0.55,
          'line-dasharray': [0.1, 1.8],
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

      // Which way round the loop goes. A gradient answers that only if you
      // know which end is which colour; an arrow answers it on sight. Added
      // last so the chevrons ride over the grey of the part already covered.
      if (!map.hasImage('route-arrow')) {
        map.addImage('route-arrow', arrowImage(), { pixelRatio: 2.6 })
      }
      map.addLayer({
        id: 'route-arrows',
        type: 'symbol',
        source: 'route',
        minzoom: 11,
        layout: {
          'symbol-placement': 'line',
          // Far enough apart to be a hint rather than a barcode, and closer
          // together as you zoom in so a single street still carries one.
          'symbol-spacing': [
            'interpolate',
            ['linear'],
            ['zoom'],
            11,
            55,
            16,
            85,
            20,
            120,
          ],
          'icon-image': 'route-arrow',
          'icon-size': ['interpolate', ['linear'], ['zoom'], 11, 0.55, 16, 0.8, 20, 1],
          // The route line is drawn to a ground width, so the arrows have to
          // lie on the ground with it rather than standing up at the camera.
          'icon-rotation-alignment': 'map',
          'icon-pitch-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
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

    /** The dotted hop from where you stand to where the way back begins. */
    setRejoinLeader(coords: LngLat[] | null) {
      source('rejoin-leader')?.setData(coords ? lineFeature(coords) : EMPTY)
    },

    showTraveled(visible: boolean) {
      map.setLayoutProperty('traveled-line', 'visibility', visible ? 'visible' : 'none')
    },

    clearNavigationLines() {
      source('rejoin')?.setData(EMPTY)
      source('rejoin-leader')?.setData(EMPTY)
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
