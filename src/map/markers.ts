import maplibregl from 'maplibre-gl'
import { ll } from './route-layers'
import type { LngLat } from '../domain/geo'

/** The start pin and the numbered stop pins. */

// Letting go of a dragged marker also fires a click, which would delete the
// stop you had just finished placing.
const DRAG_CLICK_GRACE_MS = 400

interface WaypointHandlers {
  label: (index: number) => string
  onMove: (index: number, lngLat: LngLat) => void
  onRemove: (index: number) => void
}

export function createMarkers(map: maplibregl.Map) {
  let start: maplibregl.Marker | null = null
  let stops: maplibregl.Marker[] = []
  let draggedAt = 0

  return {
    setStart(lngLat: LngLat, onDrag: (lngLat: LngLat) => void) {
      if (!start) {
        const el = document.createElement('div')
        el.className = 'start-marker'
        el.addEventListener('click', (e) => e.stopPropagation())
        start = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(ll(lngLat))
          .addTo(map)
        start.on('dragend', () => {
          const p = start!.getLngLat()
          onDrag([p.lng, p.lat])
        })
      } else {
        start.setLngLat(ll(lngLat))
      }
    },

    removeStart() {
      start?.remove()
      start = null
    },

    /** Numbered pins for the stops; tap removes, drag moves. */
    renderWaypoints(waypoints: LngLat[], handlers: WaypointHandlers) {
      this.clearWaypoints()
      waypoints.forEach((lngLat, index) => {
        const el = document.createElement('div')
        el.className = 'wp-marker'
        el.textContent = String(index + 1)
        el.setAttribute('role', 'button')
        el.title = handlers.label(index)
        el.setAttribute('aria-label', el.title)
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          if (performance.now() - draggedAt < DRAG_CLICK_GRACE_MS) return
          handlers.onRemove(index)
        })
        const marker = new maplibregl.Marker({ element: el, draggable: true })
          .setLngLat(ll(lngLat))
          .addTo(map)
        marker.on('dragend', () => {
          draggedAt = performance.now()
          const p = marker.getLngLat()
          handlers.onMove(index, [p.lng, p.lat])
        })
        stops.push(marker)
      })
    },

    clearWaypoints() {
      for (const m of stops) m.remove()
      stops = []
    },
  }
}
