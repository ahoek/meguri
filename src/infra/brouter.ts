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

/**
 * Which uploaded profile a request wants. Two switches, four sources:
 *
 * - `nature` is the estimates above.
 * - `network` is the stock profile's own `stick_to_cycleroutes`: cycle-route
 *   ways cost 1 and everything else takes a penalty, small by default and
 *   large when this is on. A knooppuntenroute turns it on so the stretches
 *   between the doorstep and the first number ride the signposted paths too.
 *
 * With both off, the stock server profile does and nothing is uploaded.
 */
export interface ProfileFlags {
  nature: boolean
  network: boolean
}

const FLAG_SWITCHES: Record<keyof ProfileFlags, string[]> = {
  nature: ['consider_noise', 'consider_forest', 'consider_town', 'consider_traffic'],
  network: ['stick_to_cycleroutes'],
}

function setSwitch(source: string, name: string, on: boolean) {
  const re = new RegExp(`^(assign\\s+${name}\\s*=\\s*)(true|false)`, 'm')
  return source.replace(re, `$1${on}`)
}

/** The uploaded source for a mode and its switches. */
export function profileSource(mode: Profile, { nature, network }: ProfileFlags) {
  let source = NATURE_SOURCE[mode]
  for (const name of FLAG_SWITCHES.nature) source = setSwitch(source, name, nature)
  for (const name of FLAG_SWITCHES.network) source = setSwitch(source, name, network)
  return source
}

const variantKey = (mode: Profile, { nature, network }: ProfileFlags) =>
  `${mode}${nature ? '' : '-plain'}${network ? '-net' : ''}`

const uploadedIds: Record<string, string> = {}

// Bump whenever a .brf changes, so clients stop reusing the id of the
// profile they registered from the previous version.
const PROFILE_VERSION = 5

function cacheKey(variant: string) {
  return `meguri-profile-${variant}-v${PROFILE_VERSION}`
}

async function registerProfile(mode: Profile, flags: ProfileFlags, signal?: AbortSignal) {
  const res = await fetch(`${BROUTER}/profile`, {
    method: 'POST',
    body: profileSource(mode, flags),
    signal,
  })
  if (!res.ok) throw new Error('Profile upload failed')
  const { profileid } = await res.json()
  if (!profileid) throw new Error('Profile upload failed')
  const variant = variantKey(mode, flags)
  uploadedIds[variant] = profileid
  try {
    localStorage.setItem(cacheKey(variant), profileid)
  } catch {
    /* storage blocked — the in-memory id still works this session */
  }
  return profileid
}

async function uploadedProfileId(mode: Profile, flags: ProfileFlags, signal?: AbortSignal) {
  const variant = variantKey(mode, flags)
  if (uploadedIds[variant]) return uploadedIds[variant]
  const cached = localStorage.getItem(cacheKey(variant))
  if (cached) {
    uploadedIds[variant] = cached
    return cached
  }
  return registerProfile(mode, flags, signal)
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
  const green = readGreen(feature.properties.messages, feature.geometry.coordinates)
  return {
    geometry: feature.geometry, // LineString, coordinates are [lng, lat, ele]
    distanceKm: Number(feature.properties['track-length']) / 1000,
    durationSec: Number(feature.properties['total-time']),
    // [pointIndex, command, exitNumber, distanceToNext, angle] per maneuver
    voicehints: feature.properties.voicehints ?? [],
    greenFraction: green.fraction,
    greenMask: green.mask,
  }
}

// BRouter's own land-cover estimate, 0 (none) to 6 (deep woodland). From this
// class up, a way counts as running through green rather than past it.
const GREEN_CLASS = 4

/**
 * What a route knows about its own greenness, read out of BRouter's message
 * table: the share of its length through green, and which segments of its
 * geometry that green actually is.
 *
 * This costs nothing: the nature profiles already reference
 * `estimated_forest_class`, so BRouter already returns it alongside the geometry
 * we asked for. It was being thrown away, which is why the planner could compare
 * two candidate loops and have no idea one of them went through a park.
 *
 * The mask is per geometry segment — `mask[i]` covers the stretch from vertex
 * `i` to `i + 1`. Each message row describes one run of way and names the exact
 * vertex it ends on (verified against the live server: every row's coordinates
 * land on a geometry vertex at microdegree precision), so the mask is built by
 * walking vertices and rows in step. If a row's end vertex cannot be found the
 * whole mask is abandoned rather than guessed at.
 *
 * Nulls rather than zeroes when the estimate is missing — the stock profiles do
 * not ask for it, and "not measured" must not be scored as "not green".
 */
export function readGreen(
  messages: unknown,
  coordinates: LngLat[],
): { fraction: number | null; mask: boolean[] | null } {
  const none = { fraction: null, mask: null }
  if (!Array.isArray(messages) || messages.length < 2) return none
  const header = messages[0]
  if (!Array.isArray(header)) return none
  const tagCol = header.indexOf('WayTags')
  const distCol = header.indexOf('Distance')
  const lonCol = header.indexOf('Longitude')
  const latCol = header.indexOf('Latitude')
  if (tagCol < 0 || distCol < 0) return none

  let total = 0
  let green = 0
  let sawEstimate = false
  const mask: boolean[] = new Array(Math.max(coordinates.length - 1, 0)).fill(false)
  let maskOk = lonCol >= 0 && latCol >= 0 && coordinates.length > 1
  let seg = 0

  for (const row of messages.slice(1)) {
    const metres = Number(row[distCol])
    let rowGreen = false
    for (const tag of String(row[tagCol]).split(' ')) {
      if (!tag.startsWith('estimated_forest_class=')) continue
      sawEstimate = true
      rowGreen = Number(tag.slice('estimated_forest_class='.length)) >= GREEN_CLASS
    }
    if (Number.isFinite(metres)) {
      total += metres
      if (rowGreen) green += metres
    }

    if (!maskOk) continue
    // Paint segments forward until we stand on the vertex this row ends at.
    const endLng = Number(row[lonCol])
    const endLat = Number(row[latCol])
    let found = false
    while (seg < mask.length) {
      mask[seg] = rowGreen
      seg += 1
      const v = coordinates[seg]
      if (Math.round(v[0] * 1e6) === endLng && Math.round(v[1] * 1e6) === endLat) {
        found = true
        break
      }
    }
    if (!found) maskOk = false
  }

  if (!total || !sawEstimate) return none
  return { fraction: green / total, mask: maskOk ? mask : null }
}

const reRegistered: Record<string, boolean> = {}

export interface RouteOptions extends Partial<ProfileFlags> {
  mode: Profile
  signal?: AbortSignal
}

/** Route through the given points with the chosen profile. */
export async function fetchRoute(
  points: LngLat[],
  { mode, nature = true, network = false, signal }: RouteOptions,
): Promise<Route> {
  if (!nature && !network) return requestRoute(points, PROFILE[mode], signal)

  const flags = { nature, network }
  const id = await uploadedProfileId(mode, flags, signal)
  try {
    return await requestRoute(points, id, signal)
  } catch (err) {
    const variant = variantKey(mode, flags)
    if ((err as Error).name === 'AbortError' || reRegistered[variant]) throw err
    // The server drops custom profiles after a while — register again once,
    // then let any further failure surface so the caller can try new terrain.
    reRegistered[variant] = true
    const freshId = await registerProfile(mode, flags, signal)
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
  return fetchRoute(points, { mode: profile, nature, signal })
}
