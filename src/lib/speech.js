import { ref, watch } from 'vue'
import { locale, t } from '../i18n.js'

// Announce each maneuver at most once per band. Ascending order matters:
// we want the *smallest* band the distance still fits in, so the near
// warnings fire as you close in rather than being swallowed by the far one.
const THRESHOLDS = [30, 150, 400]
const VOICE_LANG = { en: 'en-GB', nl: 'nl-NL', ja: 'ja-JP' }

// Spoken units are spelled out — a synthesiser reads "90 m" as "ninety m".
const SPOKEN_UNIT = {
  en: { m: 'metres', km: 'kilometres' },
  nl: { m: 'meter', km: 'kilometer' },
  ja: { m: 'メートル', km: 'キロ' },
}

let spokenFor = new Map() // maneuver key → smallest threshold already said
let saidArrived = false
let saidOffRoute = false
let unlocked = false

// ---- voice choice ----
// The browser usually offers several voices per language; remember one per
// app language. Voices load asynchronously (empty list until voiceschanged).
const VOICE_CHOICE_KEY = 'meguri-voice-choice'

function loadVoiceChoices() {
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_CHOICE_KEY))
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/** voiceURI per app language, e.g. { nl: '…Xander…' }. Empty = automatic. */
export const voiceChoice = ref(loadVoiceChoices())

/** Voices the browser offers for the current app language. */
export const availableVoices = ref([])

function refreshVoices() {
  const synth = window.speechSynthesis
  if (!synth) return
  availableVoices.value = synth
    .getVoices()
    .filter((v) => v.lang?.toLowerCase().startsWith(locale.value))
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  refreshVoices() // often empty on first call — that call starts the loading
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices)
  watch(locale, refreshVoices)
}

export function setChosenVoice(uri) {
  const next = { ...voiceChoice.value }
  if (uri) next[locale.value] = uri
  else delete next[locale.value]
  voiceChoice.value = next
  try {
    localStorage.setItem(VOICE_CHOICE_KEY, JSON.stringify(next))
  } catch {
    /* storage blocked — the choice just won't persist */
  }
  // Hearing the voice is the only way to judge it — and choosing is a
  // gesture, so this also unlocks iOS speech.
  unlocked = true
  say(t('voiceSample'))
}

function pickVoice() {
  const uri = voiceChoice.value[locale.value]
  if (!uri) return null
  return (
    window.speechSynthesis.getVoices().find((v) => v.voiceURI === uri) ?? null
  )
}

/**
 * iOS Safari refuses to speak unless the very first utterance happens inside
 * a user gesture — every later call is silently dropped. Call this straight
 * from the tap that starts navigation to open the door.
 */
export function primeSpeech() {
  const synth = window.speechSynthesis
  if (!synth || unlocked) return
  try {
    const opener = new SpeechSynthesisUtterance(' ')
    opener.volume = 0
    opener.lang = VOICE_LANG[locale.value] ?? 'en-GB'
    synth.speak(opener)
    unlocked = true
  } catch {
    /* unsupported — guidance is silent, navigation still works */
  }
}

export function resetSpeech() {
  spokenFor = new Map()
  saidArrived = false
  saidOffRoute = false
  window.speechSynthesis?.cancel()
  // `unlocked` deliberately survives: the gesture permission is per page
  // load, not per navigation session.
}

function say(text) {
  const synth = window.speechSynthesis
  if (!synth) return
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = VOICE_LANG[locale.value] ?? 'en-GB'
  const voice = pickVoice()
  if (voice) utterance.voice = voice // lang above stays as the fallback
  utterance.rate = 1.05
  // iOS parks the queue when the screen locks or the tab backgrounds, and
  // never restarts it on its own.
  if (synth.paused) synth.resume()
  synth.cancel() // a stale instruction is worse than none
  synth.speak(utterance)
}

function spokenDistance(metres) {
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
function phrase(maneuver, threshold) {
  const turn = t(`nav_${maneuver.kind}`)
  if (threshold <= 30) return turn
  const distance = spokenDistance(maneuver.distanceM)
  return locale.value === 'ja'
    ? `${distance}${t('navAhead')}${turn}`
    : `${t('navIn')} ${distance}, ${turn}`
}

export function speakManeuver({ maneuver, arrived, offRoute }) {
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
