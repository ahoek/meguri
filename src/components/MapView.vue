<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import maplibregl from 'maplibre-gl'
import {
  store,
  setStart,
  addWaypoint,
  moveWaypoint,
  removeWaypoint,
} from '../app/store'
import { distanceKm } from '../domain/geo'
import {
  nav,
  preparedRoute,
  currentIndex,
  deviceHeading,
  reckoning,
  projectedPosition,
} from '../app/nav-session'
import { traveledLine } from '../domain/navigation'
import { createStyleTweaks } from '../map/style'
import { createRouteLayers, ll } from '../map/route-layers'
import { createMarkers } from '../map/markers'
import { createPuck } from '../map/puck'
import { createFollowCamera } from '../map/follow'
import { locale, t } from '../i18n'
import type { LngLat } from '../domain/geo'
import type { Route } from '../domain/route'
import type { Projection } from '../app/nav-session'

const container = ref<HTMLElement | null>(null)
let map: maplibregl.Map
let drawFrame = 0
let resizeObserver: ResizeObserver | null = null

// Built once the map exists; every one of these owns its own state.
let styleTweaks: ReturnType<typeof createStyleTweaks>
let layers: ReturnType<typeof createRouteLayers>
let markers: ReturnType<typeof createMarkers>
let puck: ReturnType<typeof createPuck>
let camera: ReturnType<typeof createFollowCamera>

// Walking needs to see the next side street; cycling covers ground faster
// and wants a little more look-ahead.
const NAV_ZOOM = { walk: 20.4, bike: 20 }

defineExpose({
  recenter() {
    // Glide back from wherever the user panned to: seed the eased camera
    // with the current view and let the follow loop close the gap.
    camera.seedFromView()
    camera.setFraming({ zoom: NAV_ZOOM[store.mode] ?? 18, pitch: 55, padding: navPadding() })
    camera.start()
  },
})

/** Latitude the route sits at — width in metres depends on where you are. */
function routeLat() {
  return store.route?.geometry.coordinates[0]?.[1] ?? store.start?.lngLat[1] ?? 52
}

function fitPadding() {
  // On mobile, fit into whatever strip the bottom sheet leaves visible. The
  // sheet auto-collapses once a route arrives, so this is usually just the
  // handle strip.
  const mobile = matchMedia('(max-width: 760px)').matches
  return mobile
    ? { top: 70, left: 36, right: 36, bottom: (store.sheetInset || 46) + 40 }
    : { top: 90, left: 470, right: 90, bottom: 90 }
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

function drawRoute(route: Route) {
  cancelAnimationFrame(drawFrame)
  const coords = route.geometry.coordinates
  layers.setGradient(store.mode)
  layers.applyWidths(routeLat()) // metres per pixel depend on where the loop is
  map.fitBounds(layers.boundsOf(coords), { padding: fitPadding(), duration: 900 })

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    layers.setRoute(coords)
    return
  }

  // Progressive draw-in of the line
  const duration = 1600
  const startTime = performance.now()
  const step = (now: number) => {
    const t = Math.min(1, (now - startTime) / duration)
    const eased = 1 - Math.pow(1 - t, 3)
    const count = Math.max(2, Math.ceil(eased * coords.length))
    layers.setRoute(coords.slice(0, count))
    if (t < 1) drawFrame = requestAnimationFrame(step)
  }
  drawFrame = requestAnimationFrame(step)
}

/**
 * The dashed way back, which BRouter returned as real road geometry. It is
 * only recomputed every so often, so as the rider moves along it we trim off
 * the part already covered rather than drawing a line from them to it — a
 * straight bridge would cut across gardens and canals and suggest a way
 * through that isn't there.
 *
 * `rejoinTrimmed` only ever grows, and resets when a fresh path arrives: a
 * nearest-point search over the whole path could match a later stretch that
 * happens to pass close by, and lop off everything before it — which is how
 * the line came up short.
 */
let rejoinTrimmed = 0
const ON_REJOIN_M = 25 // beyond this you are not on the path, you are near it

function drawRejoin() {
  if (!nav.rejoin || !nav.offRoute) {
    layers.setRejoin(null)
    return
  }

  const path = nav.rejoin.coordinates
  const from = nav.position
  if (!from || path.length < 2) {
    layers.setRejoin(path)
    return
  }

  let nearest = rejoinTrimmed
  let best = Infinity
  for (let i = rejoinTrimmed; i < path.length; i++) {
    const d = distanceKm(from, path[i])
    if (d < best) {
      best = d
      nearest = i
    }
  }
  // Only trim while you are actually walking the path. Wander off it and you
  // get the whole of what is left — the part you haven't covered is exactly
  // the part you still need to see.
  if (best * 1000 <= ON_REJOIN_M) {
    rejoinTrimmed = Math.min(nearest, path.length - 2)
  }
  layers.setRejoin(path.slice(rejoinTrimmed))
}

let traveledPaintedAt = 0

/**
 * Grey out the route behind the rider. Follows the interpolated position so
 * the boundary sits under the arrow rather than trailing a fix behind it.
 */
function paintTraveled(position: LngLat, index: number) {
  const prepared = preparedRoute()
  if (!prepared) return

  // A few times a second is plenty and keeps long routes cheap.
  const now = performance.now()
  if (now - traveledPaintedAt < 120) return
  traveledPaintedAt = now

  // Off the route the rider is somewhere else entirely; the trail still marks
  // how far along the route they got, so it ends at the projection.
  const tip = nav.offRoute ? nav.snapped : position
  if (!tip) return
  const at = nav.offRoute ? currentIndex() : (index ?? currentIndex())
  layers.setTraveled(traveledLine(prepared, at, tip))
}

/** Everything the camera loop should draw at the eased position. */
function onFollowFrame(here: LngLat, projected: Projection) {
  puck.update(here, projected.bearing)
  if (nav.offRoute) drawRejoin()
  // The grey trail ends where the arrow is, not where the last fix was.
  paintTraveled(here, projected.index)
}

function enterNavigation() {
  styleTweaks.setCarPoisHidden(true)
  layers.showTraveled(true)
  markers.removeStart()
  markers.clearWaypoints()

  // Start the camera from wherever the planner left it and let the loop glide
  // in — zoom, tilt, padding and centre all travelling together.
  camera.seedFromView()
  camera.setFraming({ zoom: NAV_ZOOM[store.mode] ?? 18, pitch: 55, padding: navPadding() })
  camera.start()
}

function exitNavigation() {
  styleTweaks.setCarPoisHidden(false)
  camera.stop()
  puck.remove()
  layers.clearNavigationLines()
  layers.showTraveled(false)
  if (store.start) markers.setStart(store.start.lngLat, setStart)
  renderWaypoints()

  // Flatten back to 2D as part of the same camera move: a separate easeTo
  // would be cancelled by fitBounds, leaving the map still pitched.
  map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 })
  if (store.route) {
    map.fitBounds(layers.boundsOf(store.route.geometry.coordinates), {
      padding: fitPadding(),
      pitch: 0,
      bearing: 0,
      duration: 1100,
    })
  } else {
    map.easeTo({ pitch: 0, bearing: 0, duration: 900 })
  }
}

function renderWaypoints() {
  if (nav.active) return markers.clearWaypoints()
  markers.renderWaypoints(store.waypoints, {
    label: (i) => `${t('wpRemove')} ${i + 1}`,
    onMove: moveWaypoint,
    onRemove: removeWaypoint,
  })
}

onMounted(() => {
  map = new maplibregl.Map({
    container: container.value!,
    style: 'https://tiles.openfreemap.org/styles/liberty',
    // Reopen on the last used starting point; Amsterdam only on first visit.
    center: store.start ? ll(store.start.lngLat) : [4.8945, 52.3667],
    zoom: store.start ? 14 : 12.5,
    attributionControl: { compact: true },
  })
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')

  styleTweaks = createStyleTweaks(map)
  layers = createRouteLayers(map)
  markers = createMarkers(map)
  puck = createPuck(map)
  camera = createFollowCamera(map, {
    project: projectedPosition,
    active: () => nav.active,
    positionEase: () => reckoning().positionEase,
    fromCompass: () => deviceHeading() != null,
    onFrame: onFollowFrame,
  })

  // The container can be laid out after map init (style injection timing),
  // so track its size ourselves.
  resizeObserver = new ResizeObserver(() => {
    map.resize()
    if (nav.active) camera.refreshPadding(navPadding())
  })
  resizeObserver.observe(container.value!)

  map.on('load', () => {
    styleTweaks.removeExtrusions()
    layers.add(store.mode, routeLat())

    // A restored session is already in the store before the style finishes
    // loading, so paint it here rather than waiting for a change event.
    if (store.route) drawRoute(store.route)
    if (nav.active) enterNavigation()
  })

  // Any manual pan, rotate or tilt during navigation hands the camera to the
  // user; the Recenter button is the only way back. Note the follow loop's
  // own jumpTo also fires rotate/pitch events — only real gestures carry an
  // originalEvent.
  map.on('dragstart', () => {
    if (nav.active) camera.release()
  })
  map.on('rotatestart', (e) => {
    if (nav.active && e.originalEvent) camera.release()
  })
  map.on('pitchstart', (e) => {
    if (nav.active && e.originalEvent) camera.release()
  })

  // A pinch means you want a different zoom than the one we chose, but you
  // are still following.
  map.on('zoomstart', (e) => {
    if (nav.active && e.originalEvent) camera.setFraming(null)
  })

  // Freeze camera writes while fingers are down so MapLibre's touch handlers
  // get to recognise the gesture at all — see follow.ts.
  const canvas = map.getCanvasContainer()
  canvas.addEventListener('touchstart', () => camera.holdForTouch(true), { passive: true })
  const touchDone = (e: TouchEvent) => {
    if (e.touches.length === 0) camera.holdForTouch(false)
  }
  canvas.addEventListener('touchend', touchDone, { passive: true })
  canvas.addEventListener('touchcancel', touchDone, { passive: true })

  map.on('click', (e) => {
    if (nav.active) return // tapping the map must not relocate the route
    if (store.waypointMode && store.start) {
      addWaypoint([e.lngLat.lng, e.lngLat.lat])
    } else {
      setStart([e.lngLat.lng, e.lngLat.lat])
    }
  })

  watch(
    () => store.start,
    (start) => {
      if (start) markers.setStart(start.lngLat, setStart)
    },
    { immediate: true },
  )

  // Locale too: the pins carry their own "tap to remove" label.
  watch([() => store.waypoints, locale], renderWaypoints, { immediate: true })

  watch(
    () => store.route,
    (route) => {
      if (!layers.ready()) return
      route ? drawRoute(route) : (cancelAnimationFrame(drawFrame), layers.clearRoute())
    },
  )

  watch(
    () => store.flyTo,
    (target) => {
      if (!target) return
      map.flyTo({
        center: target.center as [number, number],
        zoom: target.zoom,
        duration: 1400,
        // Land centred in the strip the sheet leaves visible.
        offset: [0, -store.sheetInset / 2],
      })
    },
  )

  // Sheet opened or closed: keep the view centred on the visible strip. With
  // a route, refit the whole loop; otherwise shift by half the change so the
  // same point stays in the middle of what you can see.
  watch(
    () => store.sheetInset,
    (inset, oldInset) => {
      if (nav.active) return
      if (store.route) {
        // pitch 0: right after exiting navigation this refit cancels the
        // exit's own flattening animation, so flatten here as well.
        map.fitBounds(layers.boundsOf(store.route.geometry.coordinates), {
          padding: fitPadding(),
          pitch: 0,
          duration: 500,
        })
      } else {
        map.panBy([0, (inset - (oldInset ?? 0)) / 2], { duration: 350 })
      }
    },
  )

  watch(
    () => store.mode,
    (mode) => layers.setGradient(mode),
  )

  watch(
    () => nav.rejoin,
    () => {
      rejoinTrimmed = 0 // a fresh path starts from where the rider is now
      drawRejoin()
    },
  )

  watch(
    () => nav.active,
    (active) => {
      if (!layers.ready()) return
      active ? enterNavigation() : exitNavigation()
    },
  )
})

if (import.meta.env.DEV) {
  // Lets simulated-navigation checks inspect layers and filters.
  onMounted(() => {
    ;(window as any).__map = map
  })
}

onBeforeUnmount(() => {
  camera?.stop()
  puck?.remove()
  cancelAnimationFrame(drawFrame)
  resizeObserver?.disconnect()
  map?.remove()
})
</script>

<template>
  <div
    ref="container"
    class="map"
    :class="{ dropping: store.waypointMode }"
    :style="{ '--banner-inset': store.bannerInset + 'px' }"
    :aria-label="store.waypointMode ? t('wpArmed') : t('mapAria')"
  ></div>
</template>

<style scoped>
.map {
  position: absolute;
  inset: 0;
}

/* Armed to drop stops: say so under the pointer as well as in the prompt. */
.map.dropping :deep(.maplibregl-canvas) {
  cursor: copy;
}

/* While navigating, the instruction banner covers the top of the screen.
   Drop the zoom buttons below whatever height it has taken. */
.map :deep(.maplibregl-ctrl-top-right) {
  transition: transform 0.3s;
  transform: translateY(var(--banner-inset, 0px));
}
</style>
