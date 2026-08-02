import type { LngLat } from '../domain/geo'
import type { Route, Profile } from '../domain/route'
import bikeNatureProfile from '../profiles/bike-nature.brf?raw'
import walkNatureProfile from '../profiles/walk-nature.brf?raw'

// BRouter (brouter.de, free) instead of OSRM: its profiles actively prefer
// bike paths / footpaths, avoid busy roads and penalize traffic lights.
const BROUTER = 'https://brouter.de/brouter'
const PROFILE = { walk: 'hiking-beta', bike: 'trekking' }

// Nature variants: the stock profiles with BRouter's forest/town/noise/traffic
// estimates switched on, so green detours beat the direct route through town.
// They must be registered with the server, which hands back a temporary id.
const NATURE_SOURCE = { walk: walkNatureProfile, bike: bikeNatureProfile }
const natureIds: Partial<Record<Profile, string>> = {}

// Bump whenever a .brf changes, so clients stop reusing the id of the
// profile they registered from the previous version.
const PROFILE_VERSION = 3

function cacheKey(mode: Profile) {
  return `meguri-profile-${mode}-v${PROFILE_VERSION}`
}

async function registerNatureProfile(mode: Profile, signal?: AbortSignal) {
  const res = await fetch(`${BROUTER}/profile`, {
    method: 'POST',
    body: NATURE_SOURCE[mode],
    signal,
  })
  if (!res.ok) throw new Error('Profile upload failed')
  const { profileid } = await res.json()
  if (!profileid) throw new Error('Profile upload failed')
  natureIds[mode] = profileid
  try {
    localStorage.setItem(cacheKey(mode), profileid)
  } catch {
    /* storage blocked — the in-memory id still works this session */
  }
  return profileid
}

async function natureProfileId(mode: Profile, signal?: AbortSignal) {
  if (natureIds[mode]) return natureIds[mode]
  const cached = localStorage.getItem(cacheKey(mode))
  if (cached) {
    natureIds[mode] = cached
    return cached
  }
  return registerNatureProfile(mode, signal)
}

async function requestRoute(
  points: LngLat[],
  profileName: string,
  signal?: AbortSignal,
): Promise<Route> {
  const lonlats = points
    .map(([lng, lat]) => `${lng.toFixed(6)},${lat.toFixed(6)}`)
    .join('|')
  const url =
    `${BROUTER}?lonlats=${lonlats}&profile=${profileName}` +
    `&alternativeidx=0&format=geojson&timode=2`
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Routing failed (${res.status})`)
  const json = await res.json()
  const feature = json.features?.[0]
  if (!feature) throw new Error('No route found')
  return {
    geometry: feature.geometry, // LineString, coordinates are [lng, lat, ele]
    distanceKm: Number(feature.properties['track-length']) / 1000,
    durationSec: Number(feature.properties['total-time']),
    // [pointIndex, command, exitNumber, distanceToNext, angle] per maneuver
    voicehints: feature.properties.voicehints ?? [],
  }
}

const reRegistered: Partial<Record<Profile, boolean>> = {}

/** Route through the given points with the chosen profile. */
export async function fetchRoute(
  points: LngLat[],
  mode: Profile,
  nature: boolean,
  signal?: AbortSignal,
): Promise<Route> {
  if (!nature) return requestRoute(points, PROFILE[mode], signal)

  const id = await natureProfileId(mode, signal)
  try {
    return await requestRoute(points, id, signal)
  } catch (err) {
    if ((err as Error).name === 'AbortError' || reRegistered[mode]) throw err
    // The server drops custom profiles after a while — register again once,
    // then let any further failure surface so the caller can try new terrain.
    reRegistered[mode] = true
    const freshId = await registerNatureProfile(mode, signal)
    return requestRoute(points, freshId, signal)
  }
}

/** Route directly between waypoints — used to guide back after a wrong turn. */
export async function routeBetween({
  points,
  profile,
  nature = true,
  signal,
}: {
  points: LngLat[]
  profile: Profile
  nature?: boolean
  signal?: AbortSignal
}): Promise<Route> {
  return fetchRoute(points, profile, nature, signal)
}
