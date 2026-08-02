import type maplibregl from 'maplibre-gl'
import { shortestTurn } from '../domain/navigation'
import type { LngLat } from '../domain/geo'
import type { Projection } from '../app/nav-session'

/**
 * The navigation camera: a frame loop that keeps the rider still on screen
 * while the world moves under them.
 *
 * It owns the eased camera and the eased shown position, and nothing else —
 * what gets drawn at that position each frame is the caller's business, via
 * `onFrame`. The loop writes the camera with `jumpTo` every frame, which
 * would cancel any `easeTo`, so zoom, pitch and padding have to be eased
 * inside it too.
 */

// Turning is eased far more slowly than panning: the map swinging round at
// the same rate it slides felt abrupt at corners. A compass bearing is a
// different animal — it answers to your wrist, so it has to keep up.
const BEARING_EASE = 0.035
const COMPASS_BEARING_EASE = 0.14
// The camera centre trails the shown position through this ease. While
// riding the lag is under a metre, but after Recenter (or lifting a pinch)
// it turns the snap back into a glide.
const CENTER_EASE = 0.1
const FRAMING_EASE = 0.05 // zoom, pitch and padding settling in or out

export interface Framing {
  zoom: number
  pitch: number
  padding: { top: number; bottom: number; left: number; right: number }
}

interface Options {
  /** Where we are and which way to face, or null if we don't know yet. */
  project: () => Projection | null
  /** Whether the loop should run at all this frame. */
  active: () => boolean
  /** How much of the gap to the projection to close per frame. */
  positionEase: () => number
  /** True when the bearing comes from the compass and should follow faster. */
  fromCompass: () => boolean
  /** Draw whatever belongs at the eased position. */
  onFrame: (here: LngLat, projected: Projection) => void
}

export function createFollowCamera(map: maplibregl.Map, opts: Options) {
  const cam = { lng: 0, lat: 0, bearing: 0, valid: false }
  // The position actually drawn: eased towards the projection so a correction
  // arrives as a slow slide rather than a snap.
  const shown = { lng: 0, lat: 0, valid: false }
  let frame = 0
  let framing: Framing | null = null
  let following = true
  // True while fingers rest on the map. Each jumpTo resets MapLibre's gesture
  // handlers, so with the loop writing the camera every frame a touch pan
  // could never accumulate enough movement to start (mouse drags activate on
  // the first move, which is why panning only failed on the phone). Hold the
  // camera still while touched and let the gesture events decide what follows.
  let touched = false

  function tick() {
    frame = requestAnimationFrame(tick)
    if (!opts.active()) return

    const projected = opts.project()
    if (!projected) return

    if (!shown.valid) {
      shown.lng = projected.position[0]
      shown.lat = projected.position[1]
      shown.valid = true
    }
    const ease = opts.positionEase()
    shown.lng += (projected.position[0] - shown.lng) * ease
    shown.lat += (projected.position[1] - shown.lat) * ease
    const here: LngLat = [shown.lng, shown.lat]

    opts.onFrame(here, projected)

    if (!following || touched) return

    if (!cam.valid) {
      cam.lng = here[0]
      cam.lat = here[1]
      cam.bearing = projected.cameraBearing ?? map.getBearing()
      cam.valid = true
    }
    if (projected.cameraBearing != null) {
      const turnEase = opts.fromCompass() ? COMPASS_BEARING_EASE : BEARING_EASE
      cam.bearing += shortestTurn(cam.bearing, projected.cameraBearing) * turnEase
    }
    cam.lng += (here[0] - cam.lng) * CENTER_EASE
    cam.lat += (here[1] - cam.lat) * CENTER_EASE

    // Track the same eased point the arrow uses (with a whisker of lag), so it
    // holds still on screen and the world moves under it.
    const move: maplibregl.JumpToOptions = {
      center: [cam.lng, cam.lat],
      bearing: cam.bearing,
    }

    if (framing) {
      const zoom = map.getZoom() + (framing.zoom - map.getZoom()) * FRAMING_EASE
      const pitch = map.getPitch() + (framing.pitch - map.getPitch()) * FRAMING_EASE
      const pad = map.getPadding()
      const padTop = pad.top ?? 0
      const padBottom = pad.bottom ?? 0
      const padding = {
        top: padTop + (framing.padding.top - padTop) * FRAMING_EASE,
        bottom: padBottom + (framing.padding.bottom - padBottom) * FRAMING_EASE,
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

  return {
    start() {
      if (!frame) frame = requestAnimationFrame(tick)
    },

    stop() {
      cancelAnimationFrame(frame)
      frame = 0
      cam.valid = false
      shown.valid = false
      framing = null
    },

    /** Seed both eased points from the current view so the loop glides in. */
    seedFromView() {
      const centre = map.getCenter()
      shown.lng = centre.lng
      shown.lat = centre.lat
      shown.valid = true
      cam.lng = centre.lng
      cam.lat = centre.lat
      cam.bearing = map.getBearing()
      cam.valid = true
      following = true
    },

    setFraming(next: Framing | null) {
      framing = next
    },

    /** Keep the arrow low after a rotate or a keyboard resize. */
    refreshPadding(padding: Framing['padding']) {
      if (framing) framing.padding = padding
      else map.setPadding(padding)
    },

    /** A manual gesture takes the camera; Recenter is the way back. */
    release() {
      following = false
      framing = null
    },

    holdForTouch(down: boolean) {
      touched = down
    },

    isFollowing() {
      return following
    },
  }
}
