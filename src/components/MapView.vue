<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { store, setStart } from '../store.js'
import { nav, preparedRoute, currentIndex } from '../lib/nav-session.js'
import {
  traveledLine,
  positionAtKm,
  bearingAlong,
  segmentBearingAt,
} from '../lib/navigation.js'
import { t } from '../i18n.js'

const container = ref(null)
let map = null
let marker = null
let animationFrame = 0
let resizeObserver = null
let puck = null
let followCamera = true
let userMovedAt = 0

const EMPTY = { type: 'FeatureCollection', features: [] }

defineExpose({
  recenter() {
    followCamera = true
    userMovedAt = 0
    framing = { zoom: NAV_ZOOM[store.mode] ?? 18, pitch: 55, padding: navPadding() }
    startFollowing()
  },
})

const GRADIENTS = {
  walk: ['#059669', '#84cc16'],
  bike: ['#6366f1', '#ec4899'],
}

function lineGradient(mode) {
  const [from, to] = GRADIENTS[mode]
  return [
    'interpolate',
    ['linear'],
    ['line-progress'],
    0,
    from,
    1,
    to,
  ]
}

function routeFeature(coordinates) {
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  }
}

function fitPadding() {
  // The bottom sheet auto-collapses to ~62px once a route arrives, so the
  // route can use nearly the whole screen on mobile.
  const mobile = matchMedia('(max-width: 760px)').matches
  return mobile
    ? { top: 70, left: 36, right: 36, bottom: 140 }
    : { top: 90, left: 470, right: 90, bottom: 90 }
}

function ensureMarker(lngLat) {
  if (!marker) {
    const el = document.createElement('div')
    el.className = 'start-marker'
    el.addEventListener('click', (e) => e.stopPropagation())
    marker = new maplibregl.Marker({ element: el, draggable: true })
      .setLngLat(lngLat)
      .addTo(map)
    marker.on('dragend', () => {
      const p = marker.getLngLat()
      setStart([p.lng, p.lat])
    })
  } else {
    marker.setLngLat(lngLat)
  }
}

function clearRoute() {
  cancelAnimationFrame(animationFrame)
  map?.getSource('route')?.setData(EMPTY)
}

function drawRoute(route) {
  cancelAnimationFrame(animationFrame)
  const coords = route.geometry.coordinates
  const source = map.getSource('route')
  map.setPaintProperty('route-line', 'line-gradient', lineGradient(store.mode))

  const bounds = coords.reduce(
    (b, c) => b.extend(c),
    new maplibregl.LngLatBounds(coords[0], coords[0]),
  )
  map.fitBounds(bounds, { padding: fitPadding(), duration: 900 })

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    source.setData(routeFeature(coords))
    return
  }

  // Progressive draw-in of the line
  const duration = 1600
  const startTime = performance.now()
  const step = (now) => {
    const t = Math.min(1, (now - startTime) / duration)
    const eased = 1 - Math.pow(1 - t, 3)
    const count = Math.max(2, Math.ceil(eased * coords.length))
    source.setData(routeFeature(coords.slice(0, count)))
    if (t < 1) animationFrame = requestAnimationFrame(step)
  }
  animationFrame = requestAnimationFrame(step)
}

// Driving infrastructure is clutter on foot or on a bike: it competes with
// the route line and none of it is somewhere you're going.
const CAR_POI_CLASSES = [
  'parking',
  'parking_garage',
  'fuel',
  'car',
  'car_repair',
  'car_parts',
  'car_rental',
  'car_wash',
  'charging_station',
  'motorcycle',
  'driving_school',
]
const CAR_POI_SUBCLASSES = [
  'parking',
  'parking_garage',
  'parking_space',
  'parking_entrance',
  'fuel',
  'car',
  'car_repair',
  'car_parts',
  'car_rental',
  'car_wash',
  'charging_station',
  'motorcycle',
  'tyres',
]
const POI_LAYERS = ['poi_r1', 'poi_r7', 'poi_r20']
let basePoiFilters = null

/** Hide car-only points of interest while navigating; restore them after. */
function setCarPoisHidden(hidden) {
  if (!basePoiFilters) {
    basePoiFilters = {}
    for (const id of POI_LAYERS) {
      if (map.getLayer(id)) basePoiFilters[id] = map.getFilter(id) ?? null
    }
  }

  const exclude = [
    '!',
    [
      'any',
      ['match', ['get', 'class'], CAR_POI_CLASSES, true, false],
      ['match', ['get', 'subclass'], CAR_POI_SUBCLASSES, true, false],
    ],
  ]

  for (const [id, base] of Object.entries(basePoiFilters)) {
    if (!map.getLayer(id)) continue
    if (!hidden) map.setFilter(id, base)
    else map.setFilter(id, base ? ['all', base, exclude] : exclude)
  }
}

/**
 * Drop the style's 3D buildings. At walking and cycling zoom they tower over
 * the pitched navigation view and hide the street you're meant to be on.
 */
function removeExtrusions() {
  for (const layer of map.getStyle()?.layers ?? []) {
    if (layer.type === 'fill-extrusion') map.removeLayer(layer.id)
  }
}

// Segment bearings step from one vertex to the next, and a mapped road can
// kink by tens of degrees between them. Ease onto the target so the arrow
// swings through a corner instead of flicking. Fast enough to stay honest —
// on a straight it settles within a few frames.
const PUCK_EASE = 0.14
let puckAngle = null

function ensurePuck(lngLat, bearing) {
  if (!puck) {
    const el = document.createElement('div')
    el.className = 'nav-puck'
    el.innerHTML = '<span class="nav-puck-arrow"></span>'
    // rotationAlignment 'map' ties the arrow to the world, so MapLibre backs
    // out the map's own rotation. Rotating the element in screen space
    // instead made it point the wrong way as soon as the map turned.
    puck = new maplibregl.Marker({
      element: el,
      pitchAlignment: 'map',
      rotationAlignment: 'map',
    })
      .setLngLat(lngLat)
      .addTo(map)
  } else {
    puck.setLngLat(lngLat)
  }
  if (bearing == null) return

  // Unwrap so a turn past north takes the short way round rather than
  // spinning almost the whole way back.
  puckAngle =
    puckAngle == null
      ? bearing
      : puckAngle + shortestTurn(puckAngle, bearing) * PUCK_EASE
  puck.setRotation(puckAngle)
}

// Walking needs to see the next side street; cycling covers ground faster
// and wants a little more look-ahead.
const NAV_ZOOM = { walk: 20.4, bike: 20 }

// Phones deliver a fix every one to several seconds. Easing to each arrival
// stalls between them and then lurches, which is what made following feel
// jerky — worst on a bike. Because we know the road ahead, we instead carry
// the position forward along the route at the current pace and let each new
// fix gently correct it.
const FOLLOW_EASE = 0.12 // fraction of the remaining gap closed per frame
// Turning is eased far more slowly than panning: the map swinging round at
// the same rate it slides felt abrupt at corners.
const BEARING_EASE = 0.035
const FRAMING_EASE = 0.05 // zoom, pitch and padding settling in or out
const MAX_DEAD_RECKON_S = 8 // stop guessing if the GPS has really gone quiet
const cam = { lng: 0, lat: 0, bearing: 0, valid: false }
let followFrame = 0
// The per-frame jumpTo would cancel any easeTo, so the navigation framing has
// to be eased inside the same loop. Once it has settled we stop touching zoom
// and pitch, leaving you free to pinch.
let framing = null

function shortestTurn(from, to) {
  return ((((to - from) % 360) + 540) % 360) - 180
}

/** Where we believe we are right now, between fixes. */
function projectedNow() {
  const prepared = preparedRoute()
  if (!prepared) return null

  if (nav.offRoute || !nav.fixAt) {
    const raw = nav.snapped ?? nav.position
    return raw
      ? {
          position: raw,
          index: currentIndex(),
          bearing: nav.heading,
          cameraBearing: nav.heading,
        }
      : null
  }

  const elapsed = Math.min((performance.now() - nav.fixAt) / 1000, MAX_DEAD_RECKON_S)
  const km = nav.alongKm + (nav.paceKmh / 3600) * elapsed
  const { position, index } = positionAtKm(prepared, km)
  return {
    position,
    index,
    // The arrow shows the road you are on, measured from where you stand.
    bearing: segmentBearingAt(prepared, index, position),
    // The camera aims further ahead so it turns smoothly instead of snapping.
    cameraBearing: bearingAlong(prepared, km),
  }
}

function followTick() {
  followFrame = requestAnimationFrame(followTick)
  if (!nav.active) return

  const projected = projectedNow()
  if (!projected) return

  // The puck rides the projection too, so it glides rather than hopping.
  ensurePuck(projected.position, projected.bearing)
  // …and so does the grey trail behind it. Redrawing only on each GPS fix
  // left colour on road the rider had already passed.
  paintTraveled(projected)

  if (!followCamera) return

  if (!cam.valid) {
    cam.lng = projected.position[0]
    cam.lat = projected.position[1]
    cam.bearing = projected.cameraBearing ?? map.getBearing()
    cam.valid = true
  }

  cam.lng += (projected.position[0] - cam.lng) * FOLLOW_EASE
  cam.lat += (projected.position[1] - cam.lat) * FOLLOW_EASE
  if (projected.cameraBearing != null) {
    cam.bearing += shortestTurn(cam.bearing, projected.cameraBearing) * BEARING_EASE
  }

  const move = { center: [cam.lng, cam.lat], bearing: cam.bearing }

  if (framing) {
    const zoom = map.getZoom() + (framing.zoom - map.getZoom()) * FRAMING_EASE
    const pitch = map.getPitch() + (framing.pitch - map.getPitch()) * FRAMING_EASE
    const pad = map.getPadding()
    const padding = {
      top: pad.top + (framing.padding.top - pad.top) * FRAMING_EASE,
      bottom: pad.bottom + (framing.padding.bottom - pad.bottom) * FRAMING_EASE,
      left: 0,
      right: 0,
    }
    move.zoom = zoom
    move.pitch = pitch
    move.padding = padding
    if (
      Math.abs(framing.zoom - zoom) < 0.02 &&
      Math.abs(framing.pitch - pitch) < 0.5 &&
      Math.abs(framing.padding.top - padding.top) < 2
    ) {
      framing = null // settled — zoom is yours again
    }
  }

  map.jumpTo(move)
}

function startFollowing(snapToTarget = false) {
  if (snapToTarget) cam.valid = false
  if (!followFrame) followFrame = requestAnimationFrame(followTick)
}

function stopFollowing() {
  cancelAnimationFrame(followFrame)
  followFrame = 0
  cam.valid = false
  framing = null
  puckAngle = null
}

// Keep the arrow low after a rotate or a keyboard resize.
function refreshNavPadding() {
  if (!nav.active) return
  if (framing) framing.padding = navPadding()
  else map.setPadding(navPadding())
}

function cameraFollow(immediate = false) {
  if (immediate) cam.valid = false
}

let traveledPaintedAt = 0

/**
 * Grey out the route behind the rider. Follows the interpolated position so
 * the boundary sits under the arrow rather than trailing a fix behind it.
 */
function paintTraveled(projected) {
  const prepared = preparedRoute()
  const source = map.getSource('traveled')
  if (!prepared || !source) return

  // A few times a second is plenty and keeps long routes cheap.
  const now = performance.now()
  if (now - traveledPaintedAt < 120) return
  traveledPaintedAt = now

  const index = projected.index ?? currentIndex()
  source.setData(routeFeature(traveledLine(prepared, index, projected.position)))
}

/**
 * Shift the camera centre downwards so the arrow sits near the bottom of the
 * screen and the road ahead gets the space instead.
 */
function navPadding() {
  const height = container.value?.clientHeight ?? window.innerHeight
  const dash = 150
  return { top: Math.round(height * 0.4) + dash, bottom: dash, left: 0, right: 0 }
}

function enterNavigation() {
  setCarPoisHidden(true)
  followCamera = true
  map.setLayoutProperty('traveled-line', 'visibility', 'visible')
  marker?.remove()
  marker = null

  // Start the camera from wherever the planner left it and let the loop glide
  // in — zoom, tilt, padding and centre all travelling together.
  const centre = map.getCenter()
  cam.lng = centre.lng
  cam.lat = centre.lat
  cam.bearing = map.getBearing()
  cam.valid = true

  framing = {
    zoom: NAV_ZOOM[store.mode] ?? 18,
    pitch: 55,
    padding: navPadding(),
  }
  startFollowing()
}

function exitNavigation() {
  setCarPoisHidden(false)
  stopFollowing()
  puck?.remove()
  puck = null
  map.getSource('rejoin')?.setData(EMPTY)
  map.getSource('traveled')?.setData(EMPTY)
  map.setLayoutProperty('traveled-line', 'visibility', 'none')
  if (store.start) ensureMarker(store.start.lngLat)

  // Flatten back to 2D as part of the same camera move: a separate easeTo
  // would be cancelled by fitBounds, leaving the map still pitched.
  if (store.route) {
    const coords = store.route.geometry.coordinates
    const bounds = coords.reduce(
      (b, c) => b.extend(c),
      new maplibregl.LngLatBounds(coords[0], coords[0]),
    )
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
    map.fitBounds(bounds, {
      padding: fitPadding(),
      pitch: 0,
      bearing: 0,
      duration: 1100,
    })
  } else {
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
    map.easeTo({ pitch: 0, bearing: 0, duration: 900 })
  }
}

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    // Reopen on the last used starting point; Amsterdam only on first visit.
    center: store.start?.lngLat ?? [4.8945, 52.3667],
    zoom: store.start ? 14 : 12.5,
    attributionControl: { compact: true },
  })
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

  // The container can be laid out after map init (style injection timing),
  // so track its size ourselves.
  resizeObserver = new ResizeObserver(() => {
    map.resize()
    refreshNavPadding()
  })
  resizeObserver.observe(container.value)

  map.on('load', () => {
    removeExtrusions()
    map.addSource('route', { type: 'geojson', data: EMPTY, lineMetrics: true })
    map.addLayer({
      id: 'route-casing',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': '#ffffff',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 9, 16, 17, 20, 24],
        'line-opacity': 0.9,
      },
    })
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        // Wider at navigation zooms, where the line is the thing you follow.
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11, 20, 17],
        'line-gradient': lineGradient(store.mode),
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
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 10, 20, 14],
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
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 5, 16, 11, 20, 17],
        'line-opacity': 0.85,
      },
    })

    // A restored session is already in the store before the style finishes
    // loading, so paint it here rather than waiting for a change event.
    if (store.route) drawRoute(store.route)
    if (nav.active) enterNavigation()
  })

  // Dragging the map during navigation hands control back to the user;
  // the Recenter button (or 12s idle) resumes following.
  map.on('dragstart', () => {
    if (nav.active) {
      followCamera = false
      framing = null
      userMovedAt = performance.now()
    }
  })

  // A pinch means you want a different zoom than the one we chose.
  map.on('zoomstart', (e) => {
    if (nav.active && e.originalEvent) framing = null
  })

  map.on('click', (e) => {
    if (nav.active) return // tapping the map must not relocate the route
    setStart([e.lngLat.lng, e.lngLat.lat])
  })

  watch(
    () => store.start,
    (start) => {
      if (start) ensureMarker(start.lngLat)
    },
    { immediate: true },
  )

  watch(
    () => store.route,
    (route) => {
      if (!map.getSource('route')) return
      route ? drawRoute(route) : clearRoute()
    },
  )

  watch(
    () => store.flyTo,
    (target) => {
      if (target) map.flyTo({ center: target.center, zoom: target.zoom, duration: 1400 })
    },
  )

  watch(
    () => store.mode,
    (mode) => {
      if (map.getLayer('route-line')) {
        map.setPaintProperty('route-line', 'line-gradient', lineGradient(mode))
      }
    },
  )

  watch(
    () => nav.rejoin,
    (rejoin) => {
      const source = map.getSource('rejoin')
      if (!source) return
      source.setData(rejoin ? routeFeature(rejoin.coordinates) : EMPTY)
    },
  )

  watch(
    () => nav.active,
    (active) => {
      if (!map.getSource('traveled')) return
      active ? enterNavigation() : exitNavigation()
    },
  )

  watch(
    () => nav.snapped,
    (snapped) => {
      if (!snapped || !nav.active) return
      if (!followCamera && performance.now() - userMovedAt > 12000) {
        followCamera = true
        startFollowing()
      }
    },
  )
})

if (import.meta.env.DEV) {
  // Lets simulated-navigation checks inspect layers and filters.
  onMounted(() => {
    window.__map = map
  })
}

onBeforeUnmount(() => {
  stopFollowing()
  cancelAnimationFrame(animationFrame)
  resizeObserver?.disconnect()
  map?.remove()
})
</script>

<template>
  <div ref="container" class="map" :aria-label="t('mapAria')"></div>
</template>

<style scoped>
.map {
  position: absolute;
  inset: 0;
}
</style>
