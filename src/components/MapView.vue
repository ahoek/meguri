<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import { store, setStart } from '../store.js'
import { nav, preparedRoute, currentIndex } from '../lib/nav-session.js'
import { traveledLine } from '../lib/navigation.js'
import { t } from '../i18n.js'

const container = ref(null)
let map = null
let marker = null
let animationFrame = 0
let resizeObserver = null
let puck = null
let spotMarkers = []
let followCamera = true
let userMovedAt = 0

const EMPTY = { type: 'FeatureCollection', features: [] }

defineExpose({
  recenter() {
    followCamera = true
    userMovedAt = 0
    if (nav.position) cameraFollow(true)
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

const SPOT_GLYPH = {
  viewpoint: 'M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  artwork: 'M12 3a9 9 0 1 0 0 18c1.4 0 2-1 2-1.8 0-1.6-1.4-1.7-1.4-2.9 0-.8.7-1.3 1.6-1.3H16a5 5 0 0 0 5-5c0-3.9-4-7-9-7Z',
  water: 'M12 3s6 6.4 6 10.2A6 6 0 0 1 6 13.2C6 9.4 12 3 12 3Z',
  nature: 'm12 3 7 12H5l7-12Z M12 15v6',
  park: 'M12 3a6 6 0 0 0-2 11.7V21h4v-6.3A6 6 0 0 0 12 3Z',
  picnic: 'M4 20 12 5l8 15M7.5 14h9',
  heritage: 'M4 21h16M6 21V9l6-5 6 5v12M10 21v-6h4v6',
  windmill: 'M12 22V12m0 0 7-3m-7 3L5 9m7 3 3 7m-3-7-3-7',
}

function renderSpots() {
  spotMarkers.forEach((m) => m.remove())
  spotMarkers = []
  if (!nav.spots.length) return

  for (const spot of nav.spots) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'spot-pin'
    el.setAttribute('aria-label', spot.name)
    // Markers live inside the canvas container, so without this the click
    // also reaches the map and relocates the start, wiping the route.
    el.addEventListener('click', (e) => e.stopPropagation())
    el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${
      SPOT_GLYPH[spot.kind] ?? SPOT_GLYPH.heritage
    }" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

    const popup = new maplibregl.Popup({
      offset: 16,
      closeButton: false,
      className: 'spot-popup',
    }).setText(spot.name)

    spotMarkers.push(
      new maplibregl.Marker({ element: el })
        .setLngLat(spot.lngLat)
        .setPopup(popup)
        .addTo(map),
    )
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

function ensurePuck(lngLat) {
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
  const arrow = puck.getElement().firstElementChild
  if (nav.heading != null) {
    arrow.style.rotate = `${nav.heading}deg`
  }
}

// Walking needs to see the next side street; cycling covers ground faster
// and wants a little more look-ahead.
const NAV_ZOOM = { walk: 19, bike: 18.2 }

function cameraFollow(immediate = false) {
  if (!followCamera || !nav.position) return
  map.easeTo({
    center: nav.position,
    zoom: NAV_ZOOM[store.mode] ?? 18,
    pitch: 55,
    bearing: nav.heading ?? map.getBearing(),
    duration: immediate ? 0 : 900,
    essential: true,
  })
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
  followCamera = true
  map.setPadding({ top: 240, bottom: 160, left: 0, right: 0 })
  map.setLayoutProperty('traveled-line', 'visibility', 'visible')
  marker?.remove()
  marker = null
}

function exitNavigation() {
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
    renderSpots()
    if (nav.active) enterNavigation()
  })

  // Dragging the map during navigation hands control back to the user;
  // the Recenter button (or 12s idle) resumes following.
  map.on('dragstart', () => {
    if (nav.active) {
      followCamera = false
      userMovedAt = performance.now()
    }
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
    () => nav.spots,
    () => {
      if (map.isStyleLoaded() || map.loaded()) renderSpots()
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
    () => nav.position,
    (position) => {
      if (!position || !nav.active) return
      ensurePuck(position)
      drawTraveled()
      if (!followCamera && performance.now() - userMovedAt > 12000) {
        followCamera = true
      }
      cameraFollow()
    },
  )
})

onBeforeUnmount(() => {
  spotMarkers.forEach((m) => m.remove())
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
