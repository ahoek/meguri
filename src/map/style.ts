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
// Street furniture. In a wood the stock style puts down forty gates, twenty-five
// waste baskets and twenty lift gates, and they crowd out the handful of things
// a walker actually wants to find. None of it is a decision or a destination.
const CLUTTER_POI_CLASSES = [
  'waste_basket',
  'bollard',
  'gate',
  'lift_gate',
  'post',
  'recycling',
]

// And the opposite list: on a long walk in the woods these are the map. Water,
// a toilet, somewhere to sit, a signpost to check yourself against.
const WALK_POI_CLASSES = [
  'drinking_water',
  'toilets',
  'picnic_site',
  'shelter',
  'campsite',
  'information',
  'attraction',
  'swimming',
]
const POI_LAYERS = ['poi_r1', 'poi_r7', 'poi_r20']
// Cloned from the style's own top-rank POI layer so the useful few appear while
// you are still planning, not only once you are standing on them.
const WALK_POI_LAYER = 'poi-walk'
const WALK_POI_SOURCE_LAYER = 'poi_r20'
const WALK_POI_MINZOOM = 14.5

// Liberty draws footpaths as thin white dashes on an almost-white background,
// which is close to invisible at the zooms this app spends its time at — and
// paths are the whole point of it. Give them some ink, and tell a cycleway from
// a footway while we're there: on a bike that difference decides whether the
// turning exists for you.
//
// Muted on purpose. In open country the path network is most of what is drawn,
// so a strong colour stops being information and becomes the background.
const FOOT_COLOUR = '#ab8b64'
const CYCLE_COLOUR = '#7295ac'
const PATH_LAYERS = ['road_path_pedestrian', 'bridge_path_pedestrian', 'tunnel_path_pedestrian']
// Residential street edges: the stock casing is barely a shade off the fill,
// so a street and the space beside it read as one grey area.
const CASING_LAYERS = ['road_minor_casing', 'road_service_track_casing']

function pathColour(): maplibregl.ExpressionSpecification {
  return ['match', ['get', 'subclass'], ['cycleway'], CYCLE_COLOUR, FOOT_COLOUR]
}

/**
 * Faded where you may not go, and where you would rather not.
 *
 * The router already refuses private land, but the map still draws it, and an
 * inviting track that turns out to be someone's drive costs you the walk back.
 * Steps get the same treatment more gently — passable, but not with a bike.
 */
function pathOpacity(): maplibregl.ExpressionSpecification {
  return [
    'case',
    ['match', ['get', 'access'], ['private', 'no'], true, false],
    0.3,
    ['==', ['get', 'subclass'], 'steps'],
    0.72,
    1,
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
        map.setPaintProperty(id, 'line-opacity', pathOpacity())
        map.setPaintProperty(id, 'line-width', [
          'interpolate',
          ['exponential', 1.2],
          ['zoom'],
          14,
          1.5,
          20,
          9.5,
        ] as maplibregl.ExpressionSpecification)
      }

      for (const id of CASING_LAYERS) {
        if (map.getLayer(id)) map.setPaintProperty(id, 'line-color', '#b3ada4')
      }
    },

    /**
     * Put the countryside in front and the town behind it.
     *
     * The stock style is built for a city, where woods and meadows are the
     * spaces between things worth naming. Here they are the destination: a loop
     * is chosen for going through them. So the greens and the water come
     * forward, and the reserve boundary becomes something you can see yourself
     * crossing rather than a whisper of off-white.
     */
    favourNature() {
      // The one that matters most, and it is an ordering bug rather than a
      // colour: a park is a single grass polygon covering the whole wood, drawn
      // *after* the forest inside it, so every tree is washed flat. Moving
      // grass underneath brings the tree cover back — and with it the only
      // thing on the map that says whether you will be walking in shade or
      // across an open field.
      if (map.getLayer('landcover_grass') && map.getLayer('landcover_wood')) {
        map.moveLayer('landcover_grass', 'landcover_wood')
      }
      if (map.getLayer('landcover_wood')) {
        map.setPaintProperty('landcover_wood', 'fill-color', 'hsla(112,38%,50%,0.75)')
        map.setPaintProperty('landcover_wood', 'fill-opacity', 0.55)
      }
      if (map.getLayer('landcover_grass')) {
        map.setPaintProperty('landcover_grass', 'fill-color', 'rgba(198,222,158,1)')
        map.setPaintProperty('landcover_grass', 'fill-opacity', 0.5)
      }
      if (map.getLayer('park')) {
        map.setPaintProperty('park', 'fill-opacity', 0.55)
      }
      // Nature reserves: worth knowing where the edge is.
      if (map.getLayer('park_outline')) {
        map.setPaintProperty('park_outline', 'line-color', 'rgba(104,160,96,0.85)')
        map.setPaintProperty('park_outline', 'line-width', 1.4)
        map.setPaintProperty('park_outline', 'line-dasharray', [3, 2])
      }
      // Ditches, streams and canals are the handrails of a Dutch walk — you
      // orient off them constantly, and the stock hairline vanishes.
      if (map.getLayer('waterway_other')) {
        map.setPaintProperty('waterway_other', 'line-color', '#8ebde8')
        map.setPaintProperty('waterway_other', 'line-width', [
          'interpolate',
          ['exponential', 1.3],
          ['zoom'],
          13,
          0.8,
          20,
          7,
        ] as maplibregl.ExpressionSpecification)
      }
    },

    /**
     * A second POI layer for the few things a walker looks for, shown from far
     * enough out to plan around.
     *
     * The style only lets top-rank POIs in at zoom 17, by which point a water
     * tap is thirty metres away and no longer a choice. This clones its layer
     * wholesale — icon mapping, labels, halos and all — so the icons are the
     * same ones the sprite already provides, then hands back over at 17 rather
     * than drawing everything twice.
     */
    liftWalkPois() {
      if (map.getLayer(WALK_POI_LAYER)) return
      const source = map
        .getStyle()
        ?.layers?.find((l) => l.id === WALK_POI_SOURCE_LAYER)
      if (!source || source.type !== 'symbol') return

      map.addLayer({
        ...source,
        id: WALK_POI_LAYER,
        minzoom: WALK_POI_MINZOOM,
        maxzoom: source.minzoom ?? 17,
        filter: [
          'all',
          ['match', ['geometry-type'], ['MultiPoint', 'Point'], true, false],
          ['match', ['get', 'class'], WALK_POI_CLASSES, true, false],
        ],
      })
    },

    /**
     * Decide which points of interest are worth the space.
     *
     * Called once on load to drop the street furniture for good, and again on
     * entering and leaving navigation, when the car POIs come and go with it.
     */
    setCarPoisHidden(hidden: boolean) {
      if (!basePoiFilters) {
        basePoiFilters = {}
        for (const id of POI_LAYERS) {
          if (map.getLayer(id)) basePoiFilters[id] = map.getFilter(id) ?? null
        }
      }

      // Street furniture goes whatever we are doing. Car POIs only go while
      // navigating: driving to a wood and parking is how half these walks
      // start, so the planner needs to be able to show you the car park.
      const unwanted = [...CLUTTER_POI_CLASSES, ...(hidden ? CAR_POI_CLASSES : [])]
      const exclude: unknown[] = [
        '!',
        [
          'any',
          ['match', ['get', 'class'], unwanted, true, false],
          ...(hidden
            ? [['match', ['get', 'subclass'], CAR_POI_SUBCLASSES, true, false]]
            : []),
          ['match', ['get', 'subclass'], ['post_box'], true, false],
        ],
      ]

      for (const [id, base] of Object.entries(basePoiFilters)) {
        if (!map.getLayer(id)) continue
        map.setFilter(
          id,
          (base ? ['all', base, exclude] : exclude) as maplibregl.FilterSpecification,
        )
      }

      // The useful few, given room to win placement against their neighbours:
      // a lower sort key places first, and nothing else may overlap them.
      for (const id of [...POI_LAYERS, WALK_POI_LAYER]) {
        if (!map.getLayer(id)) continue
        const walkable: maplibregl.ExpressionSpecification = [
          'match',
          ['get', 'class'],
          WALK_POI_CLASSES,
          true,
          false,
        ]
        map.setLayoutProperty(id, 'icon-size', [
          'case',
          walkable,
          1.15,
          1,
        ] as maplibregl.ExpressionSpecification)
        map.setLayoutProperty(id, 'symbol-sort-key', [
          'case',
          walkable,
          0,
          10,
        ] as maplibregl.ExpressionSpecification)
      }
    },
  }
}
