<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { store } from '../app/store'
import {
  nav,
  stopNavigation,
  setVoice,
  compassStatus,
  retryCompass,
  usingCompass,
} from '../app/nav-session'
import { primeSpeech, chooseVoice } from '../app/guidance'
import { allVoices, voiceChoice } from '../infra/speech'
import { locale, t } from '../i18n'
import { localNumber } from '../domain/format'

const emit = defineEmits(['recenter'])

// Mirrored horizontally for the right-hand variants.
const TURN_PATHS: Record<string, string> = {
  left: 'M17 20V11a4 4 0 0 0-4-4H8',
  right: 'M7 20v-9a4 4 0 0 1 4-4h5',
  slightLeft: 'M16 20v-6.2a4 4 0 0 0-1.2-2.9L10 6.5',
  slightRight: 'M8 20v-6.2a4 4 0 0 1 1.2-2.9L14 6.5',
  sharpLeft: 'M17 20v-5a4 4 0 0 0-4-4H9m0 0 3.5-3.5M9 11l3.5 3.5',
  sharpRight: 'M7 20v-5a4 4 0 0 1 4-4h4m0 0-3.5-3.5M15 11l-3.5 3.5',
  keepLeft: 'M14 20v-7c0-2 -1-3.4-2.6-4.4L9 7',
  keepRight: 'M10 20v-7c0-2 1-3.4 2.6-4.4L15 7',
  uturn: 'M8 20v-9a4 4 0 0 1 8 0v3',
  roundabout: 'M12 20v-5m0-5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z',
  continue: 'M12 20V6',
  finish: 'M12 20V6',
}

const ARROW_HEAD: Record<string, string> = {
  left: 'm11 4-3 3 3 3',
  right: 'm13 4 3 3-3 3',
  slightLeft: 'm13 6.5-3 0 0 3',
  slightRight: 'm11 6.5 3 0 0 3',
  sharpLeft: '',
  sharpRight: '',
  keepLeft: 'm11.5 4-2.5 3 2.5 3',
  keepRight: 'm12.5 4 2.5 3-2.5 3',
  uturn: 'm13 12 3 2.5 3-2.5',
  roundabout: '',
  continue: 'm8 10 4-4 4 4',
  finish: 'm8 10 4-4 4 4',
}

const kind = computed(() => nav.maneuver?.kind ?? 'continue')

function formatDistance(metres: number | null) {
  if (metres == null) return ''
  if (metres >= 1000) return `${localNumber(metres / 1000, 1)} km`
  if (metres >= 100) return `${Math.round(metres / 10) * 10} m`
  return `${Math.max(0, Math.round(metres / 5) * 5)} m`
}

const maneuverDistance = computed(() => {
  if (!nav.maneuver) return ''
  // Rounding put "0 m" on the banner once you were on top of the turn.
  if (nav.maneuver.distanceM < 10) return t('navNow')
  return formatDistance(nav.maneuver.distanceM)
})

const remaining = computed(() => {
  const km = nav.remainingKm
  return km >= 10 ? `${localNumber(km)} km` : `${localNumber(km, 1)} km`
})

const eta = computed(() => {
  const minutes = Math.round(nav.remainingSec / 60)
  if (minutes < 60) return `${minutes} ${t('minAbbr')}`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const sp = locale.value === 'ja' ? '' : ' '
  return m
    ? `${h}${sp}${t('hourAbbr')}${sp}${m}${sp}${t('minAbbr')}`
    : `${h}${sp}${t('hourAbbr')}`
})

const arrivalClock = computed(() => {
  const at = new Date(Date.now() + nav.remainingSec * 1000)
  return at.toLocaleTimeString(locale.value, {
    hour: '2-digit',
    minute: '2-digit',
  })
})

function onVoiceToggle() {
  // Turning voice on is a gesture — use it to unlock iOS speech.
  if (!nav.voice) primeSpeech()
  setVoice(!nav.voice)
}

// Long-pressing the voice button opens the voice picker; a short tap keeps
// toggling. The release of a long press still fires a click, so it is eaten.
const voiceMenuOpen = ref(false)
const availableVoices = computed(() =>
  allVoices.value.filter((v) => v.lang?.toLowerCase().startsWith(locale.value)),
)
const chosenVoiceURI = computed(() => voiceChoice.value[locale.value] ?? '')
let pressTimer: ReturnType<typeof setTimeout> | undefined
let longPressed = false

function onVoicePressStart() {
  longPressed = false
  clearTimeout(pressTimer)
  if (availableVoices.value.length < 2) return // nothing to choose from
  pressTimer = setTimeout(() => {
    longPressed = true
    voiceMenuOpen.value = true
  }, 500)
}

function onVoicePressEnd() {
  clearTimeout(pressTimer)
}

function onVoiceClick() {
  if (longPressed) return
  onVoiceToggle()
}

function pickVoice(uri: string) {
  chooseVoice(uri) // speaks a sample, so no guessing which voice this is
  voiceMenuOpen.value = false
}

// The banner spans the width of a phone, so it sits squarely on top of the
// map's zoom buttons. Tell the map how far down it reaches — the height moves
// with the wording, so measure rather than guess.
const bannerEl = ref<HTMLElement | null>(null)
let bannerObserver: ResizeObserver | null = null

function publishBannerInset() {
  const el = bannerEl.value
  if (!el) return
  store.bannerInset = Math.round(el.getBoundingClientRect().bottom)
}

onMounted(() => {
  publishBannerInset()
  bannerObserver = new ResizeObserver(publishBannerInset)
  if (bannerEl.value) bannerObserver.observe(bannerEl.value)
})

onBeforeUnmount(() => {
  bannerObserver?.disconnect()
  store.bannerInset = 0
})

/**
 * On foot the arrow is supposed to follow the compass. When it can't, say so
 * — every failure looks the same from the pavement, and the first version
 * shipped with all of them silent.
 */
// Installed to the home screen, iOS remembers a refusal for the origin and
// will not prompt again however many times we ask — so there the honest
// advice is to reinstall, which does reset it, rather than a button that
// cannot work. In Safari the retry is real.
const standalone =
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as { standalone?: boolean }).standalone === true

const compassProblem = computed(() => {
  if (!usingCompass()) return null
  switch (compassStatus.value) {
    case 'denied':
    case 'off':
      return standalone
        ? { text: t('compassReinstall'), retry: false }
        : { text: t('compassDenied'), retry: true }
    case 'unsupported':
      return { text: t('compassUnsupported'), retry: false }
    case 'silent':
      return { text: t('compassSilent'), retry: false }
    default:
      return null
  }
})

const progress = computed(() => {
  const total = nav.alongKm + nav.remainingKm
  return total ? Math.min(100, (nav.alongKm / total) * 100) : 0
})
</script>

<template>
  <div class="nav" :class="{ arrived: nav.arrived }">
    <!-- Instruction banner -->
    <!-- Only colour it as a warning when it is actually warning about
         something; re-acquiring GPS shouldn't come up red. -->
    <div ref="bannerEl" class="banner" :class="{ warn: nav.ready && nav.offRoute }">
      <!-- No usable fix — from the very first second, or after the phone has
           been away long enough that what's on screen is history. Admitting
           that outranks every other banner: a stale one states things that
           may no longer be true. -->
      <template v-if="!nav.ready">
        <span class="gps-spinner" aria-hidden="true"></span>
        <p class="headline">{{ t('navWaitingGps') }}</p>
      </template>

      <template v-else-if="nav.arrived">
        <div class="finish-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="m5 12.5 4.5 4.5L19 7" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </div>
        <p class="headline">{{ t('navArrived') }}</p>
      </template>

      <template v-else-if="nav.offRoute">
        <div class="finish-icon warn-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M12 8v5m0 3.5v.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
            <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          </svg>
        </div>
        <p class="headline">
          {{ nav.rejoin ? t('navRejoin') : t('navOffRoute') }}
          <span v-if="nav.rejoin" class="rejoin-dist">
            {{ formatDistance(nav.rejoin.distanceKm * 1000) }}
          </span>
        </p>
      </template>

      <template v-else>
        <svg class="turn" viewBox="0 0 24 24" aria-hidden="true">
          <path :d="TURN_PATHS[kind]" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
          <path v-if="ARROW_HEAD[kind]" :d="ARROW_HEAD[kind]" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <div class="instruction">
          <span class="distance">{{ maneuverDistance }}</span>
          <span class="turn-text">{{ t(`nav_${kind}`) }}</span>
        </div>
      </template>
    </div>

    <div class="bottom">
    <Transition name="compass">
      <component
        :is="compassProblem?.retry ? 'button' : 'p'"
        v-if="compassProblem"
        class="compass-note"
        :class="{ actionable: compassProblem.retry }"
        @click="compassProblem.retry && retryCompass()"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="m15 9-2.2 5-4.8 1 2.2-5z" fill="currentColor" />
        </svg>
        {{ compassProblem.text }}
      </component>
    </Transition>

    <!-- Voice and recenter float above the bar so the figures below can be
         big enough to read from a bike. -->
    <div class="side-actions">
      <div v-if="voiceMenuOpen" class="voice-backdrop" @click="voiceMenuOpen = false"></div>
      <div v-if="voiceMenuOpen" class="voice-menu" role="menu" :aria-label="t('voiceLabel')">
        <p class="voice-menu-title">{{ t('voiceLabel') }}</p>
        <button
          role="menuitemradio"
          :aria-checked="chosenVoiceURI === ''"
          :class="{ active: chosenVoiceURI === '' }"
          @click="pickVoice('')"
        >
          {{ t('voiceAuto') }}
        </button>
        <button
          v-for="v in availableVoices"
          :key="v.voiceURI"
          role="menuitemradio"
          :aria-checked="chosenVoiceURI === v.voiceURI"
          :class="{ active: chosenVoiceURI === v.voiceURI }"
          @click="pickVoice(v.voiceURI)"
        >
          {{ v.name }}
        </button>
      </div>
      <button
        class="round-btn"
        :class="{ on: nav.voice }"
        :aria-label="t('navVoice')"
        :aria-pressed="nav.voice"
        :title="t('navVoice')"
        @click="onVoiceClick"
        @pointerdown="onVoicePressStart"
        @pointerup="onVoicePressEnd"
        @pointerleave="onVoicePressEnd"
        @pointercancel="onVoicePressEnd"
        @contextmenu.prevent
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M11 5 6.5 9H3v6h3.5L11 19z" fill="currentColor" />
          <path v-if="nav.voice" d="M15.5 8.5a5 5 0 0 1 0 7M18 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <path v-else d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
      <button
        class="round-btn"
        :aria-label="t('navRecenter')"
        :title="t('navRecenter')"
        @click="emit('recenter')"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" fill="currentColor" />
          <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M12 1.5v3.5M12 19v3.5M22.5 12H19M5 12H1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- Bottom bar -->
    <div class="dash">
      <div class="progress" role="presentation">
        <div class="progress-fill" :style="{ width: progress + '%' }"></div>
      </div>
      <div class="dash-row">
        <div class="metric">
          <span class="metric-value">{{ remaining }}</span>
          <span class="metric-label">{{ t('navRemaining') }}</span>
        </div>
        <div class="metric">
          <span class="metric-value">{{ eta }}</span>
          <span class="metric-label">{{ arrivalClock }}</span>
        </div>
        <button class="exit-btn" @click="stopNavigation">{{ t('navExit') }}</button>
      </div>
    </div>
    </div>
  </div>
</template>

<style scoped>
.nav {
  position: absolute;
  inset: 0;
  z-index: 20;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: stretch;
  /* None of this is text to copy, and iOS answers a long press on it — the
     one gesture the voice button needs — by selecting the words underneath
     and raising its own callout. */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}

.nav > *,
.bottom > * {
  pointer-events: auto;
}

.bottom {
  display: flex;
  flex-direction: column;
  pointer-events: none;
}

/* ---- instruction banner ---- */
.banner {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: calc(12px + env(safe-area-inset-top))
    calc(12px + env(safe-area-inset-right)) 0
    calc(12px + env(safe-area-inset-left));
  padding: 16px 20px;
  border-radius: 22px;
  color: #fff;
  background: linear-gradient(105deg, var(--accent-1), var(--accent-2));
  box-shadow: 0 12px 32px -10px rgba(12, 17, 27, 0.7);
  min-height: 84px;
}

.banner.warn {
  background: linear-gradient(105deg, #b45309, #dc2626);
}

.arrived .banner {
  background: linear-gradient(105deg, #047857, #16a34a);
}

.turn {
  flex: none;
  width: 52px;
  height: 52px;
}

.instruction {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.distance {
  font-size: 32px;
  font-weight: 800;
  line-height: 1.05;
  letter-spacing: -0.03em;
  font-variant-numeric: tabular-nums;
}

.turn-text {
  font-size: 16px;
  font-weight: 600;
  opacity: 0.95;
}

.rejoin-dist {
  display: block;
  font-size: 15px;
  font-weight: 600;
  opacity: 0.9;
  font-variant-numeric: tabular-nums;
}

.headline {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  line-height: 1.25;
}

.finish-icon {
  flex: none;
  width: 44px;
  height: 44px;
}

.finish-icon svg {
  width: 100%;
  height: 100%;
}

.gps-spinner {
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 3px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: nav-spin 0.9s linear infinite;
}

@keyframes nav-spin {
  to {
    transform: rotate(1turn);
  }
}

/* ---- bottom dashboard ---- */
.dash {
  margin: 0 calc(12px + env(safe-area-inset-right))
    calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
  border-radius: 22px;
  overflow: hidden;
  background: var(--surface);
  backdrop-filter: blur(22px) saturate(1.6);
  -webkit-backdrop-filter: blur(22px) saturate(1.6);
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow);
}

.progress {
  height: 4px;
  background: var(--field);
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent-1), var(--accent-2));
  transition: width 0.6s ease-out;
}

.dash-row {
  display: flex;
  align-items: center;
  gap: 20px;
  padding: 14px 18px;
}

.metric {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.metric-value {
  font-size: 31px;
  font-weight: 800;
  letter-spacing: -0.03em;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.metric-label {
  font-size: 12px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

/* ---- compass trouble ---- */
.compass-note {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 0 calc(12px + env(safe-area-inset-right)) 10px
    calc(12px + env(safe-area-inset-left));
  padding: 10px 14px;
  border-radius: 14px;
  background: var(--surface);
  backdrop-filter: blur(18px) saturate(1.6);
  -webkit-backdrop-filter: blur(18px) saturate(1.6);
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow);
  font-size: 13.5px;
  font-weight: 600;
  line-height: 1.3;
  text-align: left;
  color: var(--ink-2);
}

.compass-note svg {
  flex: none;
  width: 19px;
  height: 19px;
  color: #b45309;
}

.compass-note.actionable {
  color: var(--ink);
  border-color: #b45309;
}

.compass-enter-active,
.compass-leave-active {
  transition: opacity 0.25s, translate 0.25s;
}

.compass-enter-from,
.compass-leave-to {
  opacity: 0;
  translate: 0 8px;
}

.side-actions {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-self: flex-end;
  margin: 0 calc(14px + env(safe-area-inset-right)) 12px 0;
}

/* ---- voice picker (long-press on the voice button) ---- */
.voice-backdrop {
  position: fixed;
  inset: 0;
  pointer-events: auto;
}

.voice-menu {
  position: absolute;
  right: 62px;
  bottom: 0; /* grow upward, over the map rather than into the dash */
  min-width: 170px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px;
  border-radius: 16px;
  background: var(--surface);
  backdrop-filter: blur(20px) saturate(1.6);
  -webkit-backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow);
}

.voice-menu-title {
  margin: 2px 10px 4px;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--ink-3);
}

.voice-menu button {
  text-align: left;
  padding: 9px 11px;
  border-radius: 10px;
  font-size: 14.5px;
  font-weight: 500;
  color: var(--ink);
}

.voice-menu button.active {
  background: var(--accent-soft);
  color: var(--accent-1);
  font-weight: 700;
}

.round-btn {
  /* The long press that opens the voice picker must read as a press, not as
     a drag on the map underneath or the start of a selection. */
  touch-action: manipulation;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  /* These sit over the map now, so they carry their own surface. */
  background: var(--surface);
  backdrop-filter: blur(18px) saturate(1.6);
  -webkit-backdrop-filter: blur(18px) saturate(1.6);
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow);
  color: var(--ink-2);
  transition: background 0.2s, color 0.2s;
}

.round-btn.on {
  color: var(--accent-1);
}

.round-btn svg {
  width: 23px;
  height: 23px;
}

.exit-btn {
  margin-left: auto;
  padding: 12px 18px;
  border-radius: 13px;
  font-size: 15px;
  font-weight: 700;
  color: #fff;
  background: #dc2626;
}

@media (min-width: 761px) {
  .banner {
    max-width: 460px;
    margin-left: auto;
    margin-right: auto;
  }

  .bottom {
    width: 100%;
    max-width: 460px;
    margin-left: auto;
    margin-right: auto;
  }
}
</style>
