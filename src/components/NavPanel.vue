<script setup lang="ts">
import { computed } from 'vue'
import { nav, stopNavigation, setVoice } from '../lib/nav-session'
import { primeSpeech } from '../lib/speech'
import { locale, t } from '../i18n'
import { localNumber } from '../lib/format'

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

const progress = computed(() => {
  const total = nav.alongKm + nav.remainingKm
  return total ? Math.min(100, (nav.alongKm / total) * 100) : 0
})
</script>

<template>
  <div class="nav" :class="{ arrived: nav.arrived }">
    <!-- Instruction banner -->
    <div class="banner" :class="{ warn: nav.offRoute }">
      <template v-if="nav.arrived">
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

      <template v-else-if="!nav.ready">
        <span class="gps-spinner" aria-hidden="true"></span>
        <p class="headline">{{ t('navWaitingGps') }}</p>
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
    <!-- Voice and recenter float above the bar so the figures below can be
         big enough to read from a bike. -->
    <div class="side-actions">
      <button
        class="round-btn"
        :class="{ on: nav.voice }"
        :aria-label="t('navVoice')"
        :aria-pressed="nav.voice"
        :title="t('navVoice')"
        @click="onVoiceToggle"
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
  margin: calc(12px + env(safe-area-inset-top)) 12px 0;
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
  margin: 0 12px calc(12px + env(safe-area-inset-bottom));
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

.side-actions {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-self: flex-end;
  margin: 0 14px 12px 0;
}

.round-btn {
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
