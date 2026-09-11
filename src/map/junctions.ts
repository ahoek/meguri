import maplibregl from 'maplibre-gl'
import type { NetworkNode } from '../domain/knooppunten'

/**
 * Every numbered junction around the ride, as the signposts have them, in
 * grey: the network you could have taken. The junctions the ride does take
 * are the green badges drawn over these by the markers.
 *
 * A map layer rather than DOM markers, because a few tiles hold two and a
 * half thousand junctions and the symbol engine thins them by zoom for free.
 */

const SOURCE = 'knooppunten'
const GREY = '#6b7280'

const EMPTY = { type: 'FeatureCollection', features: [] } as const

export function createJunctionLayer(map: maplibregl.Map) {
  return {
    /** Called once the style has loaded; drawn beneath the route line. */
    add(beforeId: string) {
      map.addSource(SOURCE, { type: 'geojson', data: EMPTY })
      const before = map.getLayer(beforeId) ? beforeId : undefined
      map.addLayer(
        {
          id: 'knooppunten-badge',
          type: 'circle',
          source: SOURCE,
          minzoom: 11.5,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 11.5, 3, 14, 9],
            'circle-color': '#ffffff',
            'circle-stroke-color': GREY,
            'circle-stroke-width': 1.5,
            'circle-opacity': 0.9,
          },
        },
        before,
      )
      map.addLayer(
        {
          id: 'knooppunten-number',
          type: 'symbol',
          source: SOURCE,
          minzoom: 12.5,
          layout: {
            'text-field': ['get', 'ref'],
            'text-size': ['interpolate', ['linear'], ['zoom'], 12.5, 9, 14, 11.5],
            'text-font': ['Noto Sans Bold'],
            'text-allow-overlap': false,
            'text-padding': 1,
          },
          paint: { 'text-color': GREY },
        },
        before,
      )
    },

    set(nodes: NetworkNode[]) {
      const source = map.getSource(SOURCE) as maplibregl.GeoJSONSource | undefined
      source?.setData({
        type: 'FeatureCollection',
        features: nodes.map((n) => ({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: n.lngLat },
          properties: { ref: n.ref },
        })),
      })
    },
  }
}
