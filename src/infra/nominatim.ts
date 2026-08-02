import type { LngLat } from '../domain/geo'

const BASE = 'https://nominatim.openstreetmap.org'

interface NominatimItem {
  name?: string
  display_name?: string
  address?: Record<string, string | undefined>
  lon: string
  lat: string
}

export interface PlaceResult {
  label: string
  detail: string | undefined
  lngLat: LngLat
}

function shortLabel(item: NominatimItem) {
  const a = item.address || {}
  const main =
    item.name ||
    a.road ||
    a.pedestrian ||
    a.neighbourhood ||
    a.suburb ||
    item.display_name?.split(',')[0]
  const place = a.city || a.town || a.village || a.municipality || a.state
  return [main, place].filter(Boolean).filter((v, i, arr) => arr.indexOf(v) === i).join(', ')
}

export async function searchPlaces(
  query: string,
  signal: AbortSignal,
  lang = 'en',
): Promise<PlaceResult[]> {
  const url =
    `${BASE}/search?format=jsonv2&limit=5&addressdetails=1` +
    `&accept-language=${lang}&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { signal })
  if (!res.ok) return []
  const items: NominatimItem[] = await res.json()
  return items.map((item) => ({
    label: shortLabel(item) || item.display_name || '',
    detail: item.display_name,
    lngLat: [parseFloat(item.lon), parseFloat(item.lat)] as LngLat,
  }))
}

export async function reverseGeocode(
  [lng, lat]: LngLat,
  lang = 'en',
): Promise<string | null> {
  try {
    const url =
      `${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=17` +
      `&accept-language=${lang}&lon=${lng}&lat=${lat}`
    const res = await fetch(url)
    if (!res.ok) return null
    const item: NominatimItem = await res.json()
    return shortLabel(item) || null
  } catch {
    return null
  }
}
