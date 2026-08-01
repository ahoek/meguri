const BASE = 'https://nominatim.openstreetmap.org'

function shortLabel(item) {
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

export async function searchPlaces(query, signal, lang = 'en') {
  const url =
    `${BASE}/search?format=jsonv2&limit=5&addressdetails=1` +
    `&accept-language=${lang}&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { signal })
  if (!res.ok) return []
  const items = await res.json()
  return items.map((item) => ({
    label: shortLabel(item) || item.display_name,
    detail: item.display_name,
    lngLat: [parseFloat(item.lon), parseFloat(item.lat)],
  }))
}

export async function reverseGeocode([lng, lat], lang = 'en') {
  try {
    const url =
      `${BASE}/reverse?format=jsonv2&addressdetails=1&zoom=17` +
      `&accept-language=${lang}&lon=${lng}&lat=${lat}`
    const res = await fetch(url)
    if (!res.ok) return null
    const item = await res.json()
    return shortLabel(item) || null
  } catch {
    return null
  }
}
