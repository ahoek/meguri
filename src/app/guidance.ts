import { locale, t } from '../i18n'
import {
  primeUtterance,
  cancelSpeech,
  speak,
  voiceChoice,
  persistVoiceChoice,
} from '../infra/speech'
import type { Maneuver } from '../domain/navigation'
import type { Profile } from '../domain/route'
import type { NodeStop } from '../domain/knooppunten'

/**
 * Guidance policy: which announcements to make, when, and with which words.
 * The actual speaking is the infra/speech adapter's job.
 */

// Announce each maneuver at most once per band. Ascending order matters:
// we want the *smallest* band the distance still fits in, so the near
// warnings fire as you close in rather than being swallowed by the far one.
//
// The call at the turn itself comes late and close, on the rider's own
// numbers: twenty metres on the bike, ten on foot. At thirty it was said
// with the turn not yet in sight, and at fifteen a fix every four or five
// metres could skip the band. The two warnings before it are shared.
const THRESHOLDS: Record<Profile, number[]> = {
  walk: [10, 150, 400],
  bike: [20, 150, 400],
}
let profile: Profile = 'walk'

/** Which pace the announcements are timed for. */
export function setGuidanceProfile(mode: Profile) {
  profile = mode
}

const VOICE_LANG: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', ja: 'ja-JP' }

// Spoken units are spelled out — a synthesiser reads "90 m" as "ninety m".
const SPOKEN_UNIT: Record<string, { m: string; km: string }> = {
  en: { m: 'metres', km: 'kilometres' },
  nl: { m: 'meter', km: 'kilometer' },
  ja: { m: 'メートル', km: 'キロ' },
}

let spokenFor = new Map<string, number>() // maneuver key → smallest threshold said
let saidArrived = false
let saidOffRoute = false
let saidJunction = -1 // index of the last junction announced

const voiceLang = () => VOICE_LANG[locale.value] ?? 'en-GB'

/** Unlock iOS speech; must be called from inside a user gesture. */
export function primeSpeech() {
  primeUtterance(voiceLang())
}

export function resetSpeech() {
  spokenFor = new Map()
  saidArrived = false
  saidOffRoute = false
  saidJunction = -1
  cancelSpeech()
}

function say(text: string, { interrupt = true } = {}) {
  speak(text, voiceLang(), voiceChoice.value[locale.value], { interrupt })
}

/** Remember a voice for the current language and let it introduce itself. */
export function chooseVoice(uri: string) {
  persistVoiceChoice(locale.value, uri)
  // Hearing the voice is the only way to judge it — and choosing is a
  // gesture, so this also unlocks iOS speech.
  say(t('voiceSample'))
}

function spokenDistance(metres: number) {
  const unit = SPOKEN_UNIT[locale.value] ?? SPOKEN_UNIT.en
  const sep = locale.value === 'ja' ? '' : ' '
  if (metres >= 1000) {
    const km = (metres / 1000).toFixed(1)
    // Dutch reads decimals with a comma.
    const value = locale.value === 'nl' ? km.replace('.', ',') : km
    return `${value}${sep}${unit.km}`
  }
  return `${Math.round(metres / 10) * 10}${sep}${unit.m}`
}

/**
 * Say a thing coming up, once per distance band.
 *
 * "In 200 m, turn left" — Japanese puts the distance first, then the turn. Close
 * enough and the distance is dropped: at twenty metres "turn left" is the whole
 * of it.
 */
function announce(key: string, label: string, metres: number, bands = THRESHOLDS[profile]) {
  const threshold = bands.find((limit) => metres <= limit)
  if (threshold == null) return

  const alreadySaid = spokenFor.get(key)
  if (alreadySaid != null && alreadySaid <= threshold) return
  spokenFor.set(key, threshold)

  if (threshold <= bands[0]) return say(label)
  const distance = spokenDistance(metres)
  say(
    locale.value === 'ja'
      ? `${distance}${t('navAhead')}${label}`
      : `${t('navIn')} ${distance}, ${label}`,
  )
}

// The finish gets the far bands only. The near one would land inside the radius
// that triggers "you have arrived" a few seconds later, and being told twice
// that you are nearly somewhere is worse than being told once.
const FINISH_THRESHOLDS = [150, 400]

export function speakManeuver({
  maneuver,
  arrived,
  offRoute,
  toFinishM,
}: {
  maneuver: (Maneuver & { distanceM: number }) | null
  arrived: boolean
  offRoute: boolean
  toFinishM?: number
}) {
  if (arrived) {
    if (!saidArrived) {
      saidArrived = true
      say(t('navArrived'))
    }
    return
  }
  if (offRoute) {
    if (!saidOffRoute) {
      saidOffRoute = true
      say(t('navOffRoute'))
    }
    return
  }
  saidOffRoute = false

  // Past the last turn there is nothing left to announce but the end of the
  // walk, and saying nothing at all for the run-in leaves you wondering whether
  // guidance is still running.
  if (!maneuver) {
    if (toFinishM != null) {
      announce('finish', t('nav_finish'), toFinishM, FINISH_THRESHOLDS)
    }
    return
  }

  announce(
    `${maneuver.index}:${maneuver.kind}`,
    t(`nav_${maneuver.kind}`),
    maneuver.distanceM,
  )
}

// Said once, close: the number is read off the sign as you reach it, and
// at 120 m it came long before the sign was in sight.
const JUNCTION_ANNOUNCE_M = 40
// A turn this close to the junction is the turn at the junction.
const TURN_AT_JUNCTION_KM = 0.04

/**
 * On a knooppuntenroute the numbers are the route, so each one is called as
 * you reach it, with what to do there and the next to look for on the sign:
 * "Knooppunt 54, rechts afslaan. Volg de bordjes naar 46". The turn is the
 * ordinary instruction for that spot, folded in so it is not said twice;
 * with no turn there it says straight on, because at a junction that is
 * the thing you want to know.
 */
export function speakJunction(
  junctions: NodeStop[],
  alongKm: number,
  maneuver: (Maneuver & { distanceM: number }) | null,
) {
  const index = junctions.findIndex((j) => j.atKm * 1000 > alongKm * 1000 - JUNCTION_ANNOUNCE_M)
  if (index < 0 || index <= saidJunction) return
  const here = junctions[index]
  if ((here.atKm - alongKm) * 1000 > JUNCTION_ANNOUNCE_M) return
  saidJunction = index

  const atJunction =
    maneuver && Math.abs(maneuver.atKm - here.atKm) <= TURN_AT_JUNCTION_KM ? maneuver : null
  const turn = t(`nav_${atJunction?.kind ?? 'continue'}`)
  // Folded in here, so the separate call for the same turn stays quiet.
  if (atJunction) spokenFor.set(`${atJunction.index}:${atJunction.kind}`, 0)

  const next = junctions[index + 1]
  say(
    (next ? t('knpSpoken') : t('knpSpokenLast'))
      .replace('{a}', here.ref)
      .replace('{turn}', turn)
      .replace('{b}', next?.ref ?? ''),
    { interrupt: false },
  )
}
