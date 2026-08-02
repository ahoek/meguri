import { locale, t } from '../i18n'
import {
  primeUtterance,
  cancelSpeech,
  speak,
  voiceChoice,
  persistVoiceChoice,
} from '../infra/speech'
import type { Maneuver } from '../domain/navigation'

/**
 * Guidance policy: which announcements to make, when, and with which words.
 * The actual speaking is the infra/speech adapter's job.
 */

// Announce each maneuver at most once per band. Ascending order matters:
// we want the *smallest* band the distance still fits in, so the near
// warnings fire as you close in rather than being swallowed by the far one.
const THRESHOLDS = [30, 150, 400]
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

const voiceLang = () => VOICE_LANG[locale.value] ?? 'en-GB'

/** Unlock iOS speech; must be called from inside a user gesture. */
export function primeSpeech() {
  primeUtterance(voiceLang())
}

export function resetSpeech() {
  spokenFor = new Map()
  saidArrived = false
  saidOffRoute = false
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

/** "In 200 m, turn left" — Japanese puts the distance first, then the turn. */
function phrase(maneuver: Maneuver & { distanceM: number }, threshold: number) {
  const turn = t(`nav_${maneuver.kind}`)
  if (threshold <= 30) return turn
  const distance = spokenDistance(maneuver.distanceM)
  return locale.value === 'ja'
    ? `${distance}${t('navAhead')}${turn}`
    : `${t('navIn')} ${distance}, ${turn}`
}

export function speakManeuver({
  maneuver,
  arrived,
  offRoute,
}: {
  maneuver: (Maneuver & { distanceM: number }) | null
  arrived: boolean
  offRoute: boolean
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
  if (!maneuver) return

  const key = `${maneuver.index}:${maneuver.kind}`
  const threshold = THRESHOLDS.find((limit) => maneuver.distanceM <= limit)
  if (threshold == null) return

  const alreadySaid = spokenFor.get(key)
  if (alreadySaid != null && alreadySaid <= threshold) return

  spokenFor.set(key, threshold)
  say(phrase(maneuver, threshold))
}
