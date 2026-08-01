<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { store, setStart } from '../store.js'
import { nav, preparedRoute, currentIndex } from '../lib/nav-session.js'
import { traveledLine, positionAtKm } from '../lib/navigation.js'
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
    framing = { zoom: NAV_ZOOM[store.mode] ?? 18, pitch: 55 }
    startFollowing(true)
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

let puckAngle = null

function ensurePuck(lngLat, bearing) {
  if (!puck) {
    const el = document.createElement('div')
    el.className = 'nav-puck'
    el.innerHTML = '<span class="nav-puck-arrow"></span>'
    puck = new maplibregl.Marker({ element: el, pitchAlignment: 'map' })
      .setLngLat(lngLat)
      .addTo(map)
  } else {
    puck.setLngLat(lngLat)
  }
  if (bearing == null) return

  // Unwrap the angle so turning past north rotates the short way round
  // instead of spinning 359 degrees the other way.
  puckAngle =
    puckAngle == null ? bearing : puckAngle + shortestTurn(puckAngle, bearing)
  puck.getElement().firstElementChild.style.rotate = `${puckAngle}deg`
}

// Walking needs to see the next side street; cycling covers ground faster
// and wants a little more look-ahead.
const NAV_ZOOM = { walk: 19, bike: 18.2 }

// Phones deliver a fix every one to several seconds. Easing to each arrival
// stalls between them and then lurches, which is what made following feel
// jerky — worst on a bike. Because we know the road ahead, we instead carry
// the position forward along the route at the current pace and let each new
// fix gently correct it.
const FOLLOW_EASE = 0.12 // fraction of the remaining gap closed per frame
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
    return raw ? { position: raw, bearing: nav.heading } : null
  }

  const elapsed = Math.min((performance.now() - nav.fixAt) / 1000, MAX_DEAD_RECKON_S)
  const ahead = (nav.paceKmh / 3600) * elapsed
  const { position, bearing } = positionAtKm(prepared, nav.alongKm + ahead)
  return { position, bearing }
}

function followTick() {
  followFrame = requestAnimationFrame(followTick)
  if (!nav.active) return

  const projected = projectedNow()
  if (!projected) return

  // The puck rides the projection too, so it glides rather than hopping.
  ensurePuck(projected.position, projected.bearing)

  if (!followCamera) return

  if (!cam.valid) {
    cam.lng = projected.position[0]
    cam.lat = projected.position[1]
    cam.bearing = projected.bearing ?? map.getBearing()
    cam.valid = true
  }

  cam.lng += (projected.position[0] - cam.lng) * FOLLOW_EASE
  cam.lat += (projected.position[1] - cam.lat) * FOLLOW_EASE
  if (projected.bearing != null) {
    cam.bearing += shortestTurn(cam.bearing, projected.bearing) * FOLLOW_EASE
  }

  const move = { center: [cam.lng, cam.lat], bearing: cam.bearing }

  if (framing) {
    const zoom = map.getZoom() + (framing.zoom - map.getZoom()) * 0.08
    const pitch = map.getPitch() + (framing.pitch - map.getPitch()) * 0.08
    move.zoom = zoom
    move.pitch = pitch
    if (
      Math.abs(framing.zoom - zoom) < 0.02 &&
      Math.abs(framing.pitch - pitch) < 0.5
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

function cameraFollow(immediate = false) {
  if (immediate) cam.valid = false
}

function drawTraveled() {
  const prepared = preparedRoute()
  const source = map.getSource('traveled')
  if (!prepared || !nav.position || !source) return
  // Draw to the projected point, not the raw fix: when you wander off, the
  // travelled line should end on the route, not stretch out to you.
  const snapped = nav.snapped ?? nav.position
  source.setData(routeFeature(traveledLine(prepared, currentIndex(), snapped)))
}

function enterNavigation() {
  setCarPoisHidden(true)
  followCamera = true
  map.setPadding({ top: 240, bottom: 160, left: 0, right: 0 })
  map.setLayoutProperty('traveled-line', 'visibility', 'visible')
  marker?.remove()
  marker = null
  framing = { zoom: NAV_ZOOM[store.mode] ?? 18, pitch: 55 }
  startFollowing(true)
}

function exitNavigation() {
  setCarPoisHidden(false)
  stopFollowing()
  puck?.remove()
  puck = null
  map.getSource('rejoin')?.setData(EMPTY)
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
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
    map.fitBounds(bounds, {
      padding: fitPadding(),
      pitch: 0,
      bearing: 0,
      duration: 900,
    })
  } else {
    map.easeTo({ pitch: 0, bearing: 0, duration: 700 })
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
  resizeObserver = new ResizeObserver(() => map.resize())
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
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 7, 16, 13],
        'line-opacity': 0.9,
      },
    })
    map.addLayer({
      id: 'route-line',
      type: 'line',
      source: 'route',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8],
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
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 7],
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
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 4, 16, 8],
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
      drawTraveled()
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
