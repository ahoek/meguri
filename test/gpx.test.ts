import { afterEach, describe, expect, it, vi } from 'vitest'
import { gpxDocument } from '../src/infra/gpx'
import type { Route } from '../src/domain/route'

const route = (coordinates: number[][]): Route => ({
  geometry: { type: 'LineString', coordinates: coordinates as Route['geometry']['coordinates'] },
  distanceKm: 5.24,
  durationSec: 3600,
  voicehints: [],
})

describe('the GPX handed to the phone', () => {
  it('writes every point of the route as a track point', () => {
    const gpx = gpxDocument(route([[4.8945, 52.3667], [4.8955, 52.3677]]), 'walk')

    expect(gpx.match(/<trkpt /g)).toHaveLength(2)
    expect(gpx).toContain('lat="52.366700" lon="4.894500"')
    expect(gpx).toContain('<name>Meguri walk — 5.2 km</name>')
  })

  it('carries elevation where BRouter gave it, and omits it where it did not', () => {
    const gpx = gpxDocument(route([[4.8945, 52.3667, 3], [4.8955, 52.3677]]), 'walk')

    expect(gpx).toContain('<ele>3</ele>')
    expect(gpx).toContain('lat="52.367700" lon="4.895500"/>')
  })

  // The track name carries a translated word. An ampersand in a future
  // translation must not be the thing that makes the file unreadable.
  it('escapes the track name rather than trusting it', () => {
    const gpx = gpxDocument(route([[4.8945, 52.3667]]), 'wandel & fiets')

    expect(gpx).toContain('Meguri wandel &amp; fiets')
    expect(gpx).not.toContain('& fiets')
  })
})

/**
 * The share sheet is the point of the file: it is how the loop reaches a
 * watch, a bike's head unit, or another route app. Where there is no sheet
 * the file still has to land somewhere, so the download stays as the floor.
 */
describe('handing the route to the phone', () => {
  const loop = route([[4.8945, 52.3667], [4.8955, 52.3677]])

  /** Load a fresh module against a stubbed browser, and watch the anchor. */
  async function withBrowser(share: unknown) {
    vi.resetModules()
    Object.defineProperty(navigator, 'share', { configurable: true, value: share })
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: share ? () => true : undefined,
    })
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloads.push(this.download)
    })
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    return { downloads, ...(await import('../src/infra/gpx')) }
  }

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('offers the file to the share sheet where there is one', async () => {
    const share = vi.fn(async (_data: { files?: File[] }) => {})
    const { shareGpx, canShareGpx, downloads } = await withBrowser(share)

    expect(canShareGpx()).toBe(true)
    await shareGpx(loop, 'walk')

    const [{ files }] = share.mock.calls[0]
    expect(files![0].name).toBe('meguri-5.2km.gpx')
    expect(files![0].type).toBe('application/gpx+xml')
    expect(downloads).toEqual([]) // the sheet has it; nothing to drop
  })

  /**
   * Reported from the phone: the sheet opened, but Komoot and Bosch Flow were
   * not in it — only Save to Files and AirDrop. On iOS a share carrying
   * anything besides `files` is treated as that other thing with an attachment,
   * and the apps that registered against the GPX type never match. The sheet
   * still opens, which is exactly what makes it look like it worked.
   */
  it('hands over the file and nothing else, or the route apps do not appear', async () => {
    const share = vi.fn(async (_data: { files?: File[] }) => {})
    const { shareGpx } = await withBrowser(share)

    await shareGpx(loop, 'walk')

    expect(Object.keys(share.mock.calls[0][0])).toEqual(['files'])
  })

  // Closing the sheet is an answer. Posting the file to Downloads anyway
  // would be handing over the thing that was just declined.
  it('takes a dismissed sheet as a no', async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    })
    const { shareGpx, downloads } = await withBrowser(share)

    await shareGpx(loop, 'walk')

    expect(downloads).toEqual([])
  })

  it('falls back to the file when the sheet itself fails', async () => {
    const share = vi.fn(async () => {
      throw new Error('target refused it')
    })
    const { shareGpx, downloads } = await withBrowser(share)

    await shareGpx(loop, 'walk')

    expect(downloads).toEqual(['meguri-5.2km.gpx'])
  })

  it('downloads where the browser has no share sheet at all', async () => {
    const { shareGpx, canShareGpx, downloads } = await withBrowser(null)

    expect(canShareGpx()).toBe(false)
    await shareGpx(loop, 'walk')

    expect(downloads).toEqual(['meguri-5.2km.gpx'])
  })
})
