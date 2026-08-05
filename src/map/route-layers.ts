import maplibregl from 'maplibre-gl'
import { distanceKm } from '../domain/geo'
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
//
// Two metres rather than the original one and a half: on a phone at arm's
// length, held at a walking pace, the thinner line was hard to pick out of a
// basemap that now has legible paths of its own to compete with.
const PATH_WIDTH_M = 2
const CASING_WIDTH_M = 2.9
const EQUATOR_M_PER_PX = 156543.03392 // at zoom 0, 256 px tiles
const M_PER_DEG_LAT = 111_320
// Start and finish this close together are one place, not two.
const SAME_PLACE_M = 25

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
const ARROW_SIZE: maplibregl.ExpressionSpecification = [
  'interpolate',
  ['linear'],
  ['zoom'],
  11,
  0.55,
  16,
  0.8,
  20,
  1,
]

/** The same curve as a number, for working out what a pixel offset has to be. */
function arrowSizeAt(zoom: number) {
  const z = Math.max(11, Math.min(zoom, 20))
  return z <= 16 ? 0.55 + ((z - 11) / 5) * 0.25 : 0.8 + ((z - 16) / 4) * 0.2
}

/**
 * Lanes.
 *
 * A round trip that goes out along a path and comes back down the same one —
 * a lollipop, and the shape the start of a loop most often takes — draws both
 * legs on top of each other. One line, one colour, and two sets of chevrons
 * interleaved along it pointing opposite ways, which is not a hint about
 * direction so much as a contradiction. Worse during navigation: walk the
 * stick outbound and it greys over, so the leg you still have to walk back
 * looks like the leg you have finished.
 *
 * So the line is drawn to one side of the path it follows, the way traffic
 * keeps right. Nothing decides which leg goes where — "right of the direction
 * of travel" does it by itself, because the two legs travel opposite ways and
 * so land on opposite sides. Each lane then carries its own chevrons, and the
 * gradient and the grey each apply to one leg at a time, because the two legs
 * are simply different parts of the same line.
 *
 * Just over half the line, so the two lanes sit against each other with the
 * casing showing between them as a hairline rather than as a gap. Wider looked
 * like two routes; it also has to be paid for at every corner, below.
 */
const LANE_OFFSET_M = PATH_WIDTH_M / 2 + 0.1
const LANE_MIN_PX = 3

/**
 * Corners, rounded, because an offset line cannot turn one.
 *
 * `line-offset` shifts a drawn line sideways without knowing anything about
 * the shape it is drawing, so on the inside of a sharp corner the offset has
 * nowhere to go: the two segments fold back through each other and MapLibre
 * caps the fold with a round join. What that looks like on the map is a small
 * hook hanging off the bend — read, reasonably, as the route doubling back on
 * itself, which it is not doing.
 *
 * The fold is inherent to offsetting a hard angle, so the hard angle goes: a
 * corner sharper than `LANE_CORNER_DEG` is replaced by a short curve through
 * it. Three metres is smaller than the corner of a real street — which is a
 * curve, not a vertex — so nothing is claimed here that the road does not
 * already do, and the offset line has something to follow round.
 */
const LANE_CORNER_M = 3
const LANE_CORNER_DEG = 45
const LANE_CORNER_STEPS = 6

/**
 * The turnaround, where an out-and-back changes its mind.
 *
 * A route that reverses on the spot — the tip of a spur, or a whole there-and-
 * back walk to a waypoint the distance could not loop around — reverses at a
 * single vertex, and an offset line has no way to draw that. The lane swaps
 * sides in the space of nothing at all, so MapLibre caps each side and leaves
 * two rounded ends lying next to each other: the picture of two paths that
 * both stop here, rather than one that turns round.
 *
 * A turn needs room, so it is given some. The line splays out by
 * `LANE_TURN_M`, gently, over the last several metres, sweeps a half circle
 * around the tip and comes back. The lanes then meet in a proper loop, the way
 * a turning place is drawn on any road map, and the walker gets told the one
 * thing the two stubs never said: turn round here.
 *
 * The splay is well under a metre and spread over eight, which is less than
 * the width of the path it is drawn on.
 */
const LANE_TURN_DEG = 150
const LANE_TURN_M = 0.6
const LANE_TURN_RUN_M = 8
const LANE_TURN_STEPS = 8

/** Local metres, so angles and distances mean the same on both axes. */
function localFrame(coords: LngLat[]) {
  const k = Math.cos((coords[0][1] * Math.PI) / 180) || 1e-6
  return {
    xy: (p: LngLat) => [p[0] * k * M_PER_DEG_LAT, p[1] * M_PER_DEG_LAT],
    lngLat: ([x, y]: number[]): LngLat => [
      x / (k * M_PER_DEG_LAT),
      y / M_PER_DEG_LAT,
    ],
  }
}

/**
 * Give the tip of an out-and-back enough room to turn round in, so the two
 * lanes meet in a loop instead of ending side by side.
 */
export function capTurnarounds(coords: LngLat[]): LngLat[] {
  if (coords.length < 3) return coords
  const { xy, lngLat } = localFrame(coords)

  const out: LngLat[] = [coords[0]]
  for (let i = 1; i < coords.length - 1; i++) {
    const [ax, ay] = xy(coords[i - 1])
    const [px, py] = xy(coords[i])
    const [bx, by] = xy(coords[i + 1])
    const inLen = Math.hypot(px - ax, py - ay)
    const outLen = Math.hypot(bx - px, by - py)
    if (!inLen || !outLen) continue

    const inX = (px - ax) / inLen
    const inY = (py - ay) / inLen
    const outX = (bx - px) / outLen
    const outY = (by - py) / outLen
    const turn = Math.acos(Math.max(-1, Math.min(1, inX * outX + inY * outY)))
    if (turn * (180 / Math.PI) < LANE_TURN_DEG) {
      out.push(coords[i])
      continue
    }

    // The side the lanes are drawn on: right of the way you came in.
    const nX = inY
    const nY = -inX
    const r = LANE_TURN_M
    const run = Math.min(LANE_TURN_RUN_M, inLen / 2, outLen / 2)
    // The half circle is centred just short of the tip, so it still reaches it.
    const cx = px - r * inX
    const cy = py - r * inY

    out.push(lngLat([px - run * inX + r * nX, py - run * inY + r * nY]))
    for (let s = 0; s <= LANE_TURN_STEPS; s++) {
      const a = (s / LANE_TURN_STEPS) * Math.PI
      out.push(
        lngLat([
          cx + r * (Math.cos(a) * nX + Math.sin(a) * inX),
          cy + r * (Math.cos(a) * nY + Math.sin(a) * inY),
        ]),
      )
    }
    out.push(lngLat([px - run * inX - r * nX, py - run * inY - r * nY]))
  }
  out.push(coords[coords.length - 1])
  return out
}

/**
 * Replace sharp corners with a short curve through them, so the offset lanes
 * have a bend to follow instead of a fold.
 *
 * A quadratic Bézier with the corner as its control point: it leaves and joins
 * the straights along their own direction, so the route does not kink where
 * the curve starts. The back-off never takes more than half of either
 * neighbouring segment, or a curve on a finely mapped bend would swallow the
 * bend it was smoothing.
 */
export function roundCorners(coords: LngLat[]): LngLat[] {
  if (coords.length < 3) return coords
  const { xy, lngLat } = localFrame(coords)

  const out: LngLat[] = [coords[0]]
  for (let i = 1; i < coords.length - 1; i++) {
    const [ax, ay] = xy(coords[i - 1])
    const [px, py] = xy(coords[i])
    const [bx, by] = xy(coords[i + 1])
    const inLen = Math.hypot(px - ax, py - ay)
    const outLen = Math.hypot(bx - px, by - py)
    if (!inLen || !outLen) continue

    const inX = (px - ax) / inLen
    const inY = (py - ay) / inLen
    const outX = (bx - px) / outLen
    const outY = (by - py) / outLen
    // The angle turned through, from the dot product of the two directions.
    const turn = Math.acos(Math.max(-1, Math.min(1, inX * outX + inY * outY)))
    if (turn * (180 / Math.PI) < LANE_CORNER_DEG) {
      out.push(coords[i])
      continue
    }

    const back = Math.min(LANE_CORNER_M, inLen / 2, outLen / 2)
    const from = [px - inX * back, py - inY * back]
    const to = [px + outX * back, py + outY * back]
    for (let s = 0; s <= LANE_CORNER_STEPS; s++) {
      const t = s / LANE_CORNER_STEPS
      const u = 1 - t
      out.push(
        lngLat([
          u * u * from[0] + 2 * u * t * px + t * t * to[0],
          u * u * from[1] + 2 * u * t * py + t * t * to[1],
        ]),
      )
    }
  }
  out.push(coords[coords.length - 1])
  return out
}

/** What `groundWidth` resolves to at one zoom, as a number. */
function groundPx(metres: number, lat: number, minPx: number, zoom: number) {
  const perPx = EQUATOR_M_PER_PX * Math.cos((lat * Math.PI) / 180)
  return Math.max(minPx, (metres * Math.pow(2, zoom)) / perPx)
}

/**
 * The chevrons ride the source line, not the offset one, so they have to be
 * pushed onto their lane themselves.
 *
 * `icon-offset` is measured in the icon's own frame, which `symbol-placement:
 * line` has already rotated to follow the way you are going — so +y is to the
 * right of travel, the same side `line-offset` puts the lane on, and a chevron
 * on the way back is rotated with it. It is also multiplied by `icon-size`,
 * which changes with zoom, so that is divided out at every stop.
 */
export function laneIconOffset(lat: number): maplibregl.ExpressionSpecification {
  const stops: unknown[] = []
  for (let z = 11; z <= 22; z++) {
    const px = groundPx(LANE_OFFSET_M, lat, LANE_MIN_PX, z) / arrowSizeAt(z)
    stops.push(z, ['literal', [0, px]])
  }
  // `interpolate` takes arrays of numbers as well as numbers, which is the
  // only way to make a two-component offset follow the zoom.
  return [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    ...stops,
  ] as unknown as maplibregl.ExpressionSpecification
}

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

/**
 * The geometry the lanes are drawn from: turnarounds given room first, since a
 * reversal is not a corner and filleting one would only shave the tip off it.
 */
export function laneGeometry(coords: LngLat[]) {
  return roundCorners(capTurnarounds(coords))
}

export function createRouteLayers(map: maplibregl.Map) {
  const source = (id: string) =>
    map.getSource(id) as maplibregl.GeoJSONSource | undefined

  // Both remembered, because either can change without the other: the loop
  // moves to another latitude, or a new route stops doubling back.
  let lat = 0
  let lanes = false

  function applyLanes() {
    const offset = lanes ? groundWidth(LANE_OFFSET_M, lat, LANE_MIN_PX) : 0
    for (const id of ['route-line', 'route-casing', 'traveled-line']) {
      if (map.getLayer(id)) map.setPaintProperty(id, 'line-offset', offset)
    }
    if (map.getLayer('route-arrows')) {
      map.setLayoutProperty(
        'route-arrows',
        'icon-offset',
        lanes ? laneIconOffset(lat) : [0, 0],
      )
    }
  }

  return {
    /** Called once the style has loaded. */
    add(mode: Profile, at: number) {
      lat = at
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
      // Where the loop begins and ends. The planner has a draggable pin for the
      // start, but navigation takes it away, and on the way round there is
      // nothing to say where you set off from or where this finishes. On a round
      // trip the two are one place, so it is usually a single mark.
      map.addSource('termini', { type: 'geojson', data: EMPTY })
      map.addLayer({
        id: 'termini-halo',
        type: 'circle',
        source: 'termini',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 6, 18, 11],
          'circle-color': '#ffffff',
          'circle-opacity': 0.95,
          'circle-stroke-width': 1,
          'circle-stroke-color': 'rgba(12, 17, 27, 0.25)',
        },
      })
      map.addLayer({
        id: 'termini-dot',
        type: 'circle',
        source: 'termini',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 3, 18, 5.5],
          // Green for where you started, dark for a finish somewhere else.
          'circle-color': [
            'match',
            ['get', 'role'],
            ['finish'],
            '#0f172a',
            '#047857',
          ],
        },
      })

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
          'icon-size': ARROW_SIZE,
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

    /**
     * Draw the route as two lanes, one per direction of travel, or as a single
     * line on the path. Decided per route rather than per stretch: splitting
     * the line into offset and un-offset pieces would restart the gradient at
     * every seam, and a loop that jogs sideways halfway along reads as a
     * mistake. Set before the draw-in starts, from the whole route — a partial
     * slice does not know yet that it is going to come back this way.
     */
    useLanes(on: boolean) {
      lanes = on
      applyLanes()
    },

    /** Metres per pixel depend on latitude, so widths follow the loop. */
    applyWidths(at: number) {
      lat = at
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
      applyLanes()
    },

    setRoute(coords: LngLat[]) {
      source('route')?.setData(lineFeature(lanes ? laneGeometry(coords) : coords))
    },

    clearRoute() {
      source('route')?.setData(EMPTY)
    },

    // Rounded on the same terms as the route under it, or the grey would cut
    // the corner its own line goes round.
    setTraveled(coords: LngLat[]) {
      source('traveled')?.setData(lineFeature(lanes ? laneGeometry(coords) : coords))
    },

    setRejoin(coords: LngLat[] | null) {
      source('rejoin')?.setData(coords ? lineFeature(coords) : EMPTY)
    },

    /** The dotted hop from where you stand to where the way back begins. */
    setRejoinLeader(coords: LngLat[] | null) {
      source('rejoin-leader')?.setData(coords ? lineFeature(coords) : EMPTY)
    },

    /**
     * Mark where the loop starts and ends. One mark when they are the same
     * place, which on a round trip is the normal case; two when a trimmed spur
     * has left the finish somewhere else.
     */
    setTermini(coords: LngLat[] | null) {
      const src = source('termini')
      if (!src) return
      if (!coords || coords.length < 2) {
        src.setData(EMPTY)
        return
      }
      const start = coords[0]
      const finish = coords[coords.length - 1]
      const together = distanceKm(start, finish) * 1000 < SAME_PLACE_M
      const point = (at: LngLat, role: string) => ({
        type: 'Feature' as const,
        properties: { role },
        geometry: { type: 'Point' as const, coordinates: ll(at) },
      })
      src.setData({
        type: 'FeatureCollection',
        features: together
          ? [point(start, 'both')]
          : [point(start, 'start'), point(finish, 'finish')],
      })
    },

    showTraveled(visible: boolean) {
      map.setLayoutProperty('traveled-line', 'visibility', visible ? 'visible' : 'none')
    },

    clearNavigationLines() {
      source('rejoin')?.setData(EMPTY)
      source('rejoin-leader')?.setData(EMPTY)
      source('traveled')?.setData(EMPTY)
      source('termini')?.setData(EMPTY)
    },

    boundsOf(coords: LngLat[]) {
      return coords.reduce(
        (b, c) => b.extend(ll(c)),
        new maplibregl.LngLatBounds(ll(coords[0]), ll(coords[0])),
      )
    },
  }
}
