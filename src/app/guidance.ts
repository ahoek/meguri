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

/**
 * On a knooppuntenroute the numbers are the route, so each one is called as
 * you reach it, with what to do there and the next to look for on the sign:
 * "Knooppunt 54, rechts afslaan. Volg de bordjes naar 46". What to do there
 * is what the banner shows there, folded in so it is not said twice, and
 * failing that what the line itself does around the junction — the map is
 * what the rider compares both with, and a cue that said straight on at a
 * corner because the hint list had nothing on that metre was worse than
 * silence.
 */
export function speakJunction(
  junctions: NodeStop[],
  alongKm: number,
  line: { turnKindNear: (km: number) => string; maneuverNear: (km: number) => Maneuver | null },
) {
  const index = junctions.findIndex((j) => j.atKm * 1000 > alongKm * 1000 - JUNCTION_ANNOUNCE_M)
  if (index < 0 || index <= saidJunction) return
  const here = junctions[index]
  if ((here.atKm - alongKm) * 1000 > JUNCTION_ANNOUNCE_M) return
  saidJunction = index

  // What the banner will show at the junction, so voice and screen agree;
  // the line itself where the banner has nothing there.
  const folded = line.maneuverNear(here.atKm)
  const turn = t(`nav_${folded?.kind ?? line.turnKindNear(here.atKm)}`)
  if (folded) spokenFor.set(`${folded.index}:${folded.kind}`, 0)

  const next = junctions[index + 1]
  say(
    (next ? t('knpSpoken') : t('knpSpokenLast'))
      .replace('{a}', here.ref)
      .replace('{turn}', turn)
      .replace('{b}', next?.ref ?? ''),
    { interrupt: false },
  )
}
