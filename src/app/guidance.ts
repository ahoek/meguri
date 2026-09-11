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
// Per profile: at 16 km/h thirty metres is seven seconds, and the rider
// reported the turn arriving with the words still in the air. The bike's
// bands sit further out so each is said with the same time in hand a
// walker gets.
const THRESHOLDS: Record<Profile, number[]> = {
  walk: [30, 150, 400],
  bike: [55, 220, 500],
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

function say(text: string) {
  speak(text, voiceLang(), voiceChoice.value[locale.value])
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

// Said once, as the junction comes into view: far enough out to read the
// sign as you arrive, close enough that the turns before it have been said.
const JUNCTION_ANNOUNCE_M = 120

/**
 * On a knooppuntenroute the numbers are the route, so each one is called as
 * you reach it, with the next to look for on the sign: "Junction 54, then
 * follow the signs to 46". The turn-by-turn carries on underneath — this is
 * the extra that lets the phone stay in the pocket between the signs.
 */
export function speakJunction(junctions: NodeStop[], alongKm: number) {
  const index = junctions.findIndex((j) => j.atKm * 1000 > alongKm * 1000 - JUNCTION_ANNOUNCE_M)
  if (index < 0 || index <= saidJunction) return
  const here = junctions[index]
  if ((here.atKm - alongKm) * 1000 > JUNCTION_ANNOUNCE_M) return
  saidJunction = index
  const next = junctions[index + 1]
  say(
    next
      ? t('knpSpoken').replace('{a}', here.ref).replace('{b}', next.ref)
      : t('knpSpokenLast').replace('{a}', here.ref),
  )
}
