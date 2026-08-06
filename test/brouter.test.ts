import { describe, expect, it } from 'vitest'
import { readGreen } from '../src/infra/brouter'
import type { LngLat } from '../src/domain/geo'

/**
 * BRouter's message table, as the live server actually returns it (verified
 * 2026-08-05 against brouter.de): coordinates in microdegrees as strings, one
 * row per run of way, each row ending on an exact geometry vertex.
 */
const HEADER = [
  'Longitude',
  'Latitude',
  'Elevation',
  'Distance',
  'CostPerKm',
  'ElevCost',
  'TurnCost',
  'NodeCost',
  'InitialCost',
  'WayTags',
  'NodeTags',
  'Time',
  'Energy',
]

const at = (lng: number, lat: number): LngLat => [lng, lat]

// Four vertices; the first row covers two segments, the second row one.
const coords = [at(4.1, 52.1), at(4.11, 52.11), at(4.12, 52.12), at(4.13, 52.13)]

function row(end: LngLat, metres: number, tags: string) {
  return [
    String(Math.round(end[0] * 1e6)),
    String(Math.round(end[1] * 1e6)),
    '0',
    String(metres),
    '0',
    '0',
    '0',
    '0',
    '0',
    tags,
    '',
    '0',
    '0',
  ]
}

describe('reading green out of the message table', () => {
  it('splits the fraction and paints the mask per geometry segment', () => {
    const messages = [
      HEADER,
      row(coords[2], 300, 'highway=footway estimated_forest_class=6'),
      row(coords[3], 100, 'highway=residential estimated_forest_class=1'),
    ]

    const green = readGreen(messages, coords)

    expect(green.fraction).toBeCloseTo(0.75)
    expect(green.mask).toEqual([true, true, false])
  })

  it('reports nothing when the profile never asked for the estimate', () => {
    const messages = [
      HEADER,
      row(coords[2], 300, 'highway=footway'),
      row(coords[3], 100, 'highway=residential'),
    ]

    expect(readGreen(messages, coords)).toEqual({ fraction: null, mask: null })
  })

  // A row ending on a vertex that is not in the geometry means the table and
  // the line no longer describe the same thing. A mask shifted by one street
  // would quietly discount the wrong ground, so it is abandoned — but the
  // fraction stands, because it never depended on the alignment.
  it('drops the mask, and only the mask, when a row misses every vertex', () => {
    const messages = [
      HEADER,
      row(at(9.99, 9.99), 300, 'estimated_forest_class=6'),
      row(coords[3], 100, 'estimated_forest_class=1'),
    ]

    const green = readGreen(messages, coords)

    expect(green.fraction).toBeCloseTo(0.75)
    expect(green.mask).toBeNull()
  })

  it('has nothing to say about a response with no messages at all', () => {
    expect(readGreen(undefined, coords)).toEqual({ fraction: null, mask: null })
    expect(readGreen([], coords)).toEqual({ fraction: null, mask: null })
  })
})
