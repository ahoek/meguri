import type maplibregl from 'maplibre-gl'

/**
 * Tweaks to the vendor basemap style: things to hide or drop that fight with
 * the route rather than help you follow it.
 */

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

export function createStyleTweaks(map: maplibregl.Map) {
  // Captured the first time we hide anything, so restoring puts back exactly
  // what the style shipped with rather than a guess at it.
  let basePoiFilters: Record<string, unknown> | null = null

  return {
    /**
     * Drop the style's 3D buildings. At walking and cycling zoom they tower
     * over the pitched navigation view and hide the street you're meant to
     * be on.
     */
    removeExtrusions() {
      for (const layer of map.getStyle()?.layers ?? []) {
        if (layer.type === 'fill-extrusion') map.removeLayer(layer.id)
      }
    },

    /** Hide car-only points of interest while navigating; restore them after. */
    setCarPoisHidden(hidden: boolean) {
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
        if (!hidden) map.setFilter(id, base as maplibregl.FilterSpecification)
        else {
          map.setFilter(
            id,
            (base ? ['all', base, exclude] : exclude) as maplibregl.FilterSpecification,
          )
        }
      }
    },
  }
}
