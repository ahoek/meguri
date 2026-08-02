import maplibregl from 'maplibre-gl'
import { shortestTurn } from '../domain/navigation'
import { ll } from './route-layers'
import type { LngLat } from '../domain/geo'

/** The arrow showing where you are and which way you face. */

// Segment bearings step from one vertex to the next, and a mapped road can
// kink by tens of degrees between them. Ease onto the target so the arrow
// swings through a corner instead of flicking. Fast enough to stay honest —
// on a straight it settles within a few frames.
const PUCK_EASE = 0.14

export function createPuck(map: maplibregl.Map) {
  let marker: maplibregl.Marker | null = null
  let angle: number | null = null

  return {
    update(lngLat: LngLat, bearing: number | null) {
      if (!marker) {
        const el = document.createElement('div')
        el.className = 'nav-puck'
        el.innerHTML = '<span class="nav-puck-arrow"></span>'
        // rotationAlignment 'map' ties the arrow to the world, so MapLibre
        // backs out the map's own rotation. Rotating the element in screen
        // space instead made it point the wrong way as soon as the map turned.
        marker = new maplibregl.Marker({
          element: el,
          pitchAlignment: 'map',
          rotationAlignment: 'map',
        })
          .setLngLat(ll(lngLat))
          .addTo(map)
      } else {
        marker.setLngLat(ll(lngLat))
      }
      if (bearing == null) return

      // Unwrap so a turn past north takes the short way round rather than
      // spinning almost the whole way back.
      angle = angle == null ? bearing : angle + shortestTurn(angle, bearing) * PUCK_EASE
      marker.setRotation(angle)
    },

    /** Forget the eased angle so the next session doesn't spin in from it. */
    reset() {
      angle = null
    },

    remove() {
      marker?.remove()
      marker = null
      angle = null
    },
  }
}
