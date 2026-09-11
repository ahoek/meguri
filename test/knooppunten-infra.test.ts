import { describe, expect, it } from 'vitest'
import { legWaysFromOsm } from '../src/infra/knooppunten'

/**
 * The OSM API's `relation/{id}/full.json`, as it actually answers (checked
 * 2026-09-11): the relation, its member ways as node-id lists, and every
 * node those ways use, in one flat list.
 */
describe('reading a leg out of the OSM API', () => {
  const json = {
    elements: [
      { type: 'node', id: 1, lat: 52.1, lon: 4.3 },
      { type: 'node', id: 2, lat: 52.11, lon: 4.31 },
      { type: 'node', id: 3, lat: 52.12, lon: 4.32 },
      { type: 'way', id: 10, nodes: [1, 2] },
      { type: 'way', id: 11, nodes: [2, 3] },
      { type: 'way', id: 12, nodes: [3, 99] }, // a node the answer lacks
      {
        type: 'relation',
        id: 500,
        members: [
          { type: 'way', ref: 10, role: '' },
          { type: 'way', ref: 11, role: 'forward' },
          { type: 'way', ref: 12, role: '' },
          { type: 'node', ref: 1, role: 'guidepost' },
        ],
      },
    ],
  }

  it('joins ways to their coordinates and keeps the roles', () => {
    const ways = legWaysFromOsm(json, 500)
    expect(ways).toHaveLength(2) // the one-point way is no way at all
    expect(ways[0].points).toEqual([[4.3, 52.1], [4.31, 52.11]])
    expect(ways[1].role).toBe('forward')
  })

  it('answers nothing for a relation that is not in the reply', () => {
    expect(legWaysFromOsm(json, 501)).toEqual([])
  })
})
