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

// Liberty draws footpaths as thin white dashes on an almost-white background,
// which is close to invisible at the zooms this app spends its time at — and
// paths are the whole point of it. Give them the ink they deserve, and tell a
// cycleway from a footway while we're there: on a bike that difference decides
// whether the turning exists for you.
const FOOT_COLOUR = '#a2763f'
const CYCLE_COLOUR = '#4f7fa8'
const PATH_LAYERS = ['road_path_pedestrian', 'bridge_path_pedestrian', 'tunnel_path_pedestrian']
// Residential street edges: the stock casing is barely a shade off the fill,
// so a street and the space beside it read as one grey area.
const CASING_LAYERS = ['road_minor_casing', 'road_service_track_casing']

function pathColour(): maplibregl.ExpressionSpecification {
  return [
    'match',
    ['get', 'subclass'],
    ['cycleway'],
    CYCLE_COLOUR,
    FOOT_COLOUR,
  ]
}

export function createStyleTweaks(map: maplibregl.Map) {
  // Captured the first time we hide anything, so restoring puts back exactly
  // what the style shipped with rather than a guess at it.
  let basePoiFilters: Record<string, unknown> | null = null

  return {
    /**
     * Keep the style's 3D buildings, but make them glass.
     *
     * Solid, they tower over the pitched navigation view and hide the street
     * you're meant to be on, which is why they used to be deleted outright.
     * Translucent they do the job they're good at — telling you which of two
     * identical-looking corners you're standing on — and the road underneath
     * still shows through them.
     */
    softenExtrusions() {
      for (const layer of map.getStyle()?.layers ?? []) {
        if (layer.type !== 'fill-extrusion') continue
        map.setPaintProperty(layer.id, 'fill-extrusion-opacity', 0.35)
        // Without a gradient a wall of 35% grey boxes is a haze; with one the
        // edges come back and they read as buildings again.
        map.setPaintProperty(layer.id, 'fill-extrusion-vertical-gradient', true)
        map.setPaintProperty(layer.id, 'fill-extrusion-color', '#9ca3af')
      }
    },

    /**
     * Give paths and minor roads enough contrast to navigate by. Applied once
     * on load and left alone: this is how the map should look everywhere, not
     * something navigation turns on.
     */
    clarifyWays() {
      for (const id of PATH_LAYERS) {
        if (!map.getLayer(id)) continue
        map.setPaintProperty(id, 'line-color', pathColour())
        // Longer marks with smaller gaps: a dash still says "not a road",
        // but a dotted hairline says nothing at all.
        map.setPaintProperty(id, 'line-dasharray', [2.2, 1.1])
        map.setPaintProperty(id, 'line-width', [
          'interpolate',
          ['exponential', 1.2],
          ['zoom'],
          14,
          1.6,
          20,
          11,
        ] as maplibregl.ExpressionSpecification)
      }

      for (const id of CASING_LAYERS) {
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', '#b3ada4')
      }

      // Steps are a path you cannot ride and can barely push a bike up; worth
      // being able to spot before you commit to one.
      if (map.getLayer('road_path_pedestrian')) {
        map.setPaintProperty('road_path_pedestrian', 'line-opacity', [
          'match',
          ['get', 'subclass'],
          ['steps'],
          0.75,
          1,
        ] as maplibregl.ExpressionSpecification)
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
