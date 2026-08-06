<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store } from '../app/store'
import {
  nav,
  stopNavigation,
  setVoice,
  compassStatus,
  retryCompass,
  usingCompass,
  setDemoSpeed,
  toggleDemoPaused,
  toggleDemoStraying,
  DEMO_SPEEDS,
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

/**
 * Past the last turn there is no manoeuvre left, and the banner used to fall
 * back to a bare "continue straight" with the distance field empty — nothing on
 * it changing again for the rest of the loop, which is indistinguishable from
 * the guidance having frozen. On a round trip that is the whole run-in to the
 * finish. So when the turns run out, the finish becomes the instruction and the
 * distance counts down to it.
 */
const kind = computed(() => nav.maneuver?.kind ?? 'finish')

/**
 * A turn landing on top of the next one is part of the same instruction.
 *
 * On foot the phone comes out at the fork and goes away again, so "right" and
 * "right, then immediately left" have to be distinguishable in the one look
 * you get. Beyond this gap it is a separate decision and can wait its turn.
 */
const THEN_M = 80

const thenKind = computed(() =>
  nav.then && nav.then.gapM < THEN_M ? nav.then.kind : null,
)

function formatDistance(metres: number | null) {
  if (metres == null) return ''
  if (metres >= 1000) return `${localNumber(metres / 1000, 1)} km`
  if (metres >= 100) return `${Math.round(metres / 10) * 10} m`
  return `${Math.max(0, Math.round(metres / 5) * 5)} m`
}

const maneuverDistance = computed(() => {
  const metres = nav.maneuver
    ? nav.maneuver.distanceM
    : nav.remainingKm * 1000 // no turns left: how far to the finish
  // Rounding put "0 m" on the banner once you were on top of the turn.
  if (metres < 10) return t('navNow')
  return formatDistance(metres)
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

/**
 * The instruction changes size — "Nu ga rechtsaf" is one line, a turn with a
 * "daarna" is two — and a box that snaps between them yanks everything
 * anchored beneath it. So the content is measured and the box is *told* its
 * height, which CSS can then ease; anything reading the measured insets moves
 * with the same easing for free.
 */
const bannerBodyEl = ref<HTMLElement | null>(null)
const bannerH = ref<number | null>(null)

function publishBannerInset() {
  const el = bannerEl.value
  if (!el) return
  store.bannerInset = Math.round(el.getBoundingClientRect().bottom)
  if (bannerBodyEl.value) bannerH.value = bannerBodyEl.value.offsetHeight
}

/**
 * How much of the bottom of the screen the dashboard occupies, margin and safe
 * area included, so anything floating above it can sit just clear of it.
 *
 * Measured rather than written down: the dashboard's height moves with the
 * wording — a two-hour estimate in Japanese is not the same box as "55 min" —
 * and a constant would be wrong in exactly the languages nobody checks.
 */
const navEl = ref<HTMLElement | null>(null)
const dashEl = ref<HTMLElement | null>(null)
const dashInset = ref(0)
let dashObserver: ResizeObserver | null = null

function measureDash() {
  const nav = navEl.value
  const dash = dashEl.value
  if (!nav || !dash) return
  dashInset.value = Math.round(
    nav.getBoundingClientRect().bottom - dash.getBoundingClientRect().top,
  )
}

onMounted(() => {
  publishBannerInset()
  bannerObserver = new ResizeObserver(publishBannerInset)
  if (bannerEl.value) bannerObserver.observe(bannerEl.value)
  if (bannerBodyEl.value) bannerObserver.observe(bannerBodyEl.value)

  measureDash()
  dashObserver = new ResizeObserver(measureDash)
  if (dashEl.value) dashObserver.observe(dashEl.value)
  if (navEl.value) dashObserver.observe(navEl.value)
})

onBeforeUnmount(() => {
  bannerObserver?.disconnect()
  dashObserver?.disconnect()
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

// Dismissible: on a device with no magnetometer, or one where the answer has
// been refused for good, the note is a permanent strip of screen spent saying
// something that cannot change. Cleared again whenever the status does, so a
// different problem still gets to speak up.
const compassDismissed = ref(false)
watch(compassStatus, () => (compassDismissed.value = false))

/**
 * The recenter button doubles as a compass while one is actually steering:
 * walking, permission granted, readings coming in. The map turns with your
 * wrist there, so "which way is north" is a question the screen keeps
 * re-asking — the needle answers it, and the tap still recentres. On a bike
 * (or with the compass refused) the map's bearing means something else, and
 * the plain crosshair stays.
 */
const showCompass = computed(
  () => usingCompass() && compassStatus.value === 'live',
)

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
  <div
    ref="navEl"
    class="nav"
    :class="{ arrived: nav.arrived }"
    :style="{
      '--dash-inset': dashInset + 'px',
      '--banner-inset': store.bannerInset + 'px',
    }"
  >
    <!-- Demo controls. Under the banner, out of the way of everything the
         navigation itself owns, and saying plainly that the position is
         invented — a screen claiming to know where you are when it doesn't is
         the one thing this must never do quietly. -->
    <div v-if="nav.demo" class="demo-strip">
      <span class="demo-badge">{{ t('demoBadge') }}</span>
      <div class="demo-buttons">
        <button
          class="demo-btn"
          :aria-label="nav.demo.paused ? t('demoResume') : t('demoPause')"
          :title="nav.demo.paused ? t('demoResume') : t('demoPause')"
          @click="toggleDemoPaused"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path v-if="nav.demo.paused" d="M8 5.5v13l11-6.5z" fill="currentColor" />
            <path v-else d="M8.5 5.5v13M15.5 5.5v13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" />
          </svg>
        </button>
        <button
          v-for="factor in DEMO_SPEEDS"
          :key="factor"
          class="demo-btn demo-speed"
          :class="{ on: nav.demo.speed === factor }"
          :aria-label="`${t('demoSpeed')} ${factor}×`"
          :aria-pressed="nav.demo.speed === factor"
          @click="setDemoSpeed(factor)"
        >
          {{ factor }}×
        </button>
        <button
          class="demo-btn demo-stray"
          :class="{ on: nav.demo.straying }"
          :aria-label="nav.demo.straying ? t('demoRejoin') : t('demoStray')"
          :title="nav.demo.straying ? t('demoRejoin') : t('demoStray')"
          :aria-pressed="nav.demo.straying"
          @click="toggleDemoStraying"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 21V11a4 4 0 0 1 4-4h4m0 0-3-3m3 3-3 3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Instruction banner -->
    <!-- Only colour it as a warning when it is actually warning about
         something; re-acquiring GPS shouldn't come up red. -->
    <div
      ref="bannerEl"
      class="banner"
      :class="{ warn: nav.ready && nav.offRoute }"
      :style="{ height: bannerH == null ? undefined : bannerH + 'px' }"
    >
      <div ref="bannerBodyEl" class="banner-body">
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
          <!-- The second half of a double turn, so one look at the fork is
               enough and the phone can go back in your pocket. -->
          <span v-if="thenKind" class="then">
            <svg class="then-turn" viewBox="0 0 24 24" aria-hidden="true">
              <path :d="TURN_PATHS[thenKind]" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
              <path v-if="ARROW_HEAD[thenKind]" :d="ARROW_HEAD[thenKind]" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ t('navThen') }} {{ t(`nav_${thenKind}`) }}
          </span>
        </div>
      </template>
      </div>
    </div>

    <!-- Out of the flow entirely, anchored to the bottom-left above the dash.
         Sharing a container with the buttons went wrong twice: stacked, it
         pushed them up the screen; in a row, dismissing it dropped them to the
         left. It has nothing to say about where they go, so it is no longer in
         a position to. `--dash-inset` is measured, not guessed. -->
    <Transition name="compass">
      <div
        v-if="compassProblem && !compassDismissed"
        class="compass-note"
        :class="{ actionable: compassProblem.retry }"
      >
        <svg class="compass-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="m15 9-2.2 5-4.8 1 2.2-5z" fill="currentColor" />
        </svg>
        <!-- Only a note worth tapping becomes a button; the rest is text. -->
        <component
          :is="compassProblem.retry ? 'button' : 'span'"
          class="compass-text"
          @click="compassProblem.retry && retryCompass()"
        >
          {{ compassProblem.text }}
        </component>
        <button
          class="compass-dismiss"
          :aria-label="t('dismiss')"
          :title="t('dismiss')"
          @click="compassDismissed = true"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </Transition>

    <div class="bottom">
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
        <!-- With a live compass the button is one: the needle tracks the
             map's real bearing, red end to north. No transition — updates
             arrive per frame while the map turns, and easing a wrapped angle
             spins the long way round at the ±180 seam. -->
        <!-- The needle is the icon: it fills the button, and the ring is a
             faint suggestion of a bezel rather than a competing shape — at
             23px, anything the needle cedes to decoration it cannot spare. -->
        <svg v-if="showCompass" class="compass" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="10.6" fill="none" stroke="currentColor" stroke-width="1.1" opacity="0.35" />
          <g :style="{ transform: `rotate(${-store.mapBearing}deg)`, transformOrigin: '12px 12px' }">
            <path d="M12 2.4 15.4 12 12 12z" fill="#f87171" />
            <path d="M12 2.4 8.6 12 12 12z" fill="#ef4444" />
            <path d="M12 21.6 15.4 12 12 12z" fill="currentColor" opacity="0.55" />
            <path d="M12 21.6 8.6 12 12 12z" fill="currentColor" opacity="0.85" />
          </g>
          <circle cx="12" cy="12" r="1.7" fill="currentColor" />
        </svg>
        <svg v-else viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="3.2" fill="currentColor" />
          <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2" />
          <path d="M12 1.5v3.5M12 19v3.5M22.5 12H19M5 12H1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- Bottom bar -->
    <div ref="dashEl" class="dash">
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
  margin: calc(12px + env(safe-area-inset-top))
    calc(12px + env(safe-area-inset-right)) 0
    calc(12px + env(safe-area-inset-left));
  border-radius: 22px;
  color: #fff;
  background: linear-gradient(105deg, var(--accent-1), var(--accent-2));
  box-shadow: 0 12px 32px -10px rgba(12, 17, 27, 0.7);
  /* The shell is told its height (measured off .banner-body) so the wording
     changing from one line to two eases instead of snapping — and everything
     anchored to the measured insets below rides the same curve. */
  overflow: hidden;
  transition: height 0.28s ease;
}

.banner-body {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px 20px;
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

/* The follow-up turn: present, clearly secondary, readable at arm's length. */
.then {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 5px;
  font-size: 14.5px;
  font-weight: 600;
  opacity: 0.82;
}

.then-turn {
  flex: none;
  width: 17px;
  height: 17px;
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

/* ---- demo controls ----
   Anchored under the banner, which measures its own height and publishes it. */
.demo-strip {
  position: absolute;
  top: calc(var(--banner-inset, 96px) + 10px);
  transition: top 0.28s ease;
  left: calc(12px + env(safe-area-inset-left));
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
}

.demo-badge {
  padding: 4px 9px;
  border-radius: 8px;
  /* The one thing on screen that should look like a stamp rather than a
     control: it is a statement about what you are looking at. */
  background: #b45309;
  color: #fff;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  box-shadow: 0 3px 10px -4px rgba(12, 17, 27, 0.6);
}

.demo-buttons {
  display: flex;
  gap: 5px;
}

.demo-btn {
  display: grid;
  place-items: center;
  min-width: 34px;
  height: 34px;
  padding: 0 7px;
  border-radius: 10px;
  background: var(--surface);
  backdrop-filter: blur(18px) saturate(1.6);
  -webkit-backdrop-filter: blur(18px) saturate(1.6);
  border: 1px solid var(--hairline);
  box-shadow: 0 4px 14px -8px rgba(12, 17, 27, 0.5);
  color: var(--ink-2);
  font-size: 12.5px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  transition: color 0.2s, border-color 0.2s;
}

.demo-btn svg {
  width: 16px;
  height: 16px;
}

.demo-btn.on {
  color: var(--accent-1);
  border-color: var(--accent-1);
}

.demo-btn.demo-stray.on {
  color: #b45309;
  border-color: #b45309;
}

/* ---- compass trouble ----
   An aside, not an alarm: the arrow still points somewhere sensible without a
   compass, it just doesn't turn with your wrist. Full width made it a band
   across the middle of the map, so it is a chip now — sized to its words,
   tucked to the left opposite the round buttons, and quiet enough to ignore. */
.compass-note {
  position: absolute;
  left: calc(12px + env(safe-area-inset-left));
  /* Just clear of the dashboard, whatever height it has taken. */
  bottom: calc(var(--dash-inset, 102px) + 10px);
  transition: bottom 0.28s ease;
  display: flex;
  align-items: center;
  gap: 7px;
  /* Clear of the round buttons on the right, on the narrowest phone. */
  max-width: min(58%, 270px);
  padding: 7px 9px 7px 11px;
  border-radius: 12px;
  background: var(--surface);
  backdrop-filter: blur(18px) saturate(1.6);
  -webkit-backdrop-filter: blur(18px) saturate(1.6);
  border: 1px solid var(--hairline);
  box-shadow: 0 4px 14px -8px rgba(12, 17, 27, 0.5);
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  text-align: left;
  color: var(--ink-3);
}

.compass-icon {
  flex: none;
  width: 15px;
  height: 15px;
  color: var(--ink-3);
  opacity: 0.8;
}

/* Tappable, so it earns a little more ink than the ones that can only be read. */
.compass-note.actionable {
  color: var(--ink-2);
}

.compass-note.actionable .compass-icon {
  color: #b45309;
  opacity: 1;
}

/* Inherits the note's type so a button and a span read identically. */
.compass-text {
  flex: 1;
  min-width: 0;
  text-align: left;
  font: inherit;
  color: inherit;
}

.compass-dismiss {
  flex: none;
  display: grid;
  place-items: center;
  /* Small to look at, but still a thumb-sized target. */
  width: 26px;
  height: 26px;
  margin: -6px -5px -6px 0;
  border-radius: 50%;
  color: var(--ink-3);
  opacity: 0.65;
}

.compass-dismiss svg {
  width: 13px;
  height: 13px;
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

/* Right-hand edge, its own business. Nothing else shares this column. */
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

/* A glyph sits inside its button; a compass IS its button. At the shared
   23px the face floated in the middle of a 50px circle like a trinket, so
   this one icon grows until its bezel nearly meets the button's own edge. */
.round-btn svg.compass {
  width: 38px;
  height: 38px;
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

/* A phone on its side. The centred cards above split the short axis into a
   letterbox with the map showing through the gap, so the whole interface
   moves into a column on the left — banner, demo strip, dashboard, the lot —
   and the road ahead gets the right of the screen, which is where the camera
   aims it (see navPadding). Height rather than width tells a rotated phone
   apart from a desktop window, which is wide too but has room to centre. */
@media (max-height: 500px) and (orientation: landscape) {
  .banner {
    max-width: 370px;
    margin-left: calc(12px + env(safe-area-inset-left));
    margin-right: auto;
  }

  .bottom {
    max-width: calc(382px + env(safe-area-inset-left));
    margin-left: 0;
    margin-right: auto;
  }

  /* The round buttons belong to the map, not to the column: pinned to the
     screen's lower right, where the thumb on that side of the phone lives —
     leaving the column its familiar top-to-bottom read of banner, demo
     strip, dashboard. */
  .side-actions {
    position: absolute;
    right: calc(14px + env(safe-area-inset-right));
    bottom: calc(12px + env(safe-area-inset-bottom));
    margin: 0;
  }
}
</style>
