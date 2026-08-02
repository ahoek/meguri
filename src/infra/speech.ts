import { ref } from 'vue'

/**
 * The speechSynthesis adapter: priming, speaking, and the voice inventory.
 * What to say and when is guidance policy and lives in app/guidance.
 */

let unlocked = false

/**
 * iOS Safari refuses to speak unless the very first utterance happens inside
 * a user gesture — every later call is silently dropped. Call this straight
 * from the tap that starts navigation to open the door.
 */
export function primeUtterance(lang: string) {
  const synth = window.speechSynthesis
  if (!synth || unlocked) return
  try {
    const opener = new SpeechSynthesisUtterance(' ')
    opener.volume = 0
    opener.lang = lang
    synth.speak(opener)
    unlocked = true
  } catch {
    /* unsupported — guidance is silent, navigation still works */
  }
}

export function cancelSpeech() {
  window.speechSynthesis?.cancel()
  // `unlocked` deliberately survives: the gesture permission is per page
  // load, not per navigation session.
}

export function speak(text: string, lang: string, voiceURI?: string) {
  const synth = window.speechSynthesis
  if (!synth) return
  const utterance = new SpeechSynthesisUtterance(text)
  utterance.lang = lang // the fallback when no explicit voice matches
  if (voiceURI) {
    const voice = synth.getVoices().find((v) => v.voiceURI === voiceURI)
    if (voice) utterance.voice = voice
  }
  utterance.rate = 1.05
  // iOS parks the queue when the screen locks or the tab backgrounds, and
  // never restarts it on its own.
  if (synth.paused) synth.resume()
  synth.cancel() // a stale instruction is worse than none
  synth.speak(utterance)
  unlocked = true // speaking from a gesture opens the iOS door too
}

// ---- voice inventory ----
// Voices load asynchronously: the list is empty until voiceschanged fires.
export const allVoices = ref<SpeechSynthesisVoice[]>([])

function refreshVoices() {
  const synth = window.speechSynthesis
  if (!synth) return
  allVoices.value = synth.getVoices()
}

if (typeof window !== 'undefined' && window.speechSynthesis) {
  refreshVoices() // often empty on first call — that call starts the loading
  window.speechSynthesis.addEventListener?.('voiceschanged', refreshVoices)
}

// ---- remembered choice, one voiceURI per app language ----
const VOICE_CHOICE_KEY = 'meguri-voice-choice'

function loadVoiceChoices(): Record<string, string> {
  try {
    const saved = JSON.parse(localStorage.getItem(VOICE_CHOICE_KEY) ?? 'null')
    return saved && typeof saved === 'object' ? saved : {}
  } catch {
    return {}
  }
}

/** voiceURI per app language, e.g. { nl: '…Xander…' }. Empty = automatic. */
export const voiceChoice = ref<Record<string, string>>(loadVoiceChoices())

export function persistVoiceChoice(lang: string, uri: string) {
  const next = { ...voiceChoice.value }
  if (uri) next[lang] = uri
  else delete next[lang]
  voiceChoice.value = next
  try {
    localStorage.setItem(VOICE_CHOICE_KEY, JSON.stringify(next))
  } catch {
    /* storage blocked — the choice just won't persist */
  }
}
