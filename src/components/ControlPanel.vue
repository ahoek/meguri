<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  store,
  RANGES,
  SPEEDS,
  targetKm,
  setStart,
  setNature,
  locate,
  generate,
  showError,
} from '../store.js'
import { searchPlaces } from '../lib/geocode.js'
import { downloadGpx } from '../lib/gpx.js'
import { startNavigation } from '../lib/nav-session.js'
import { primeSpeech } from '../lib/speech.js'
import { LOCALES, locale, setLocale, t } from '../i18n.js'
import { localNumber } from '../lib/format.js'

const query = ref('')
const results = ref([])
const searching = ref(false)
const listOpen = ref(false)
let debounceTimer = null
let searchAbort = null

// Mobile bottom sheet: collapse to a slim bar so the route stays visible.
const collapsed = ref(false)
const isMobile = () => matchMedia('(max-width: 760px)').matches
const panelEl = ref(null)
const HANDLE_H = 58 // keep in sync with --handle-h

watch(
  () => store.route,
  (route) => {
    if (route && isMobile()) collapsed.value = true
  },
)

watch(
  () => store.start,
  () => {
    collapsed.value = false
  },
)

// The sheet tracks the finger while dragging and snaps on release, judged by
// flick velocity first and position second — the fixed-threshold swipe it
// replaces ignored both, which is what made it feel non-native.
const collapsedOffset = () => (panelEl.value?.offsetHeight ?? 0) - HANDLE_H
let drag = null

function onHandleTouchStart(e) {
  drag = {
    startY: e.touches[0].clientY,
    base: collapsed.value ? collapsedOffset() : 0,
    offset: null,
    lastY: e.touches[0].clientY,
    lastT: performance.now(),
    velocity: 0,
  }
  panelEl.value.classList.add('dragging')
}

function onHandleTouchMove(e) {
  if (!drag) return
  const y = e.touches[0].clientY
  const now = performance.now()
  if (now > drag.lastT) drag.velocity = (y - drag.lastY) / (now - drag.lastT)
  drag.lastY = y
  drag.lastT = now

  const max = collapsedOffset()
  let offset = drag.base + (y - drag.startY)
  // Rubber-band past the ends instead of stopping dead.
  if (offset < 0) offset *= 0.18
  else if (offset > max) offset = max + (offset - max) * 0.18
  drag.offset = offset
  panelEl.value.style.transform = `translateY(${offset}px)`
}

function onHandleTouchEnd(e) {
  if (!drag) return
  const d = drag
  drag = null
  panelEl.value.classList.remove('dragging')
  panelEl.value.style.transform = ''
  // Barely moved: it's a tap, and the click handler will toggle.
  if (d.offset == null || Math.abs(d.lastY - d.startY) < 6) return
  e.preventDefault() // a real drag must not also fire the click toggle
  collapsed.value =
    Math.abs(d.velocity) > 0.35 ? d.velocity > 0 : d.offset > collapsedOffset() / 2
}

// Tell the map how much of the viewport the sheet is covering, so it can
// centre things in the strip that stays visible.
function publishInset() {
  if (!isMobile()) {
    store.sheetInset = 0
    return
  }
  store.sheetInset = collapsed.value
    ? HANDLE_H
    : (panelEl.value?.offsetHeight ?? HANDLE_H)
}

watch(collapsed, publishInset)
let insetObserver = null
onMounted(() => {
  publishInset()
  insetObserver = new ResizeObserver(publishInset)
  insetObserver.observe(panelEl.value)
})
onBeforeUnmount(() => {
  insetObserver?.disconnect()
  store.sheetInset = 0
})

watch(query, (q) => {
  clearTimeout(debounceTimer)
  searchAbort?.abort()
  if (q.trim().length < 3) {
    results.value = []
    listOpen.value = false
    return
  }
  debounceTimer = setTimeout(async () => {
    searching.value = true
    searchAbort = new AbortController()
    try {
      results.value = await searchPlaces(q, searchAbort.signal, locale.value)
      listOpen.value = results.value.length > 0
    } catch {
      /* aborted or offline — keep quiet */
    } finally {
      searching.value = false
    }
  }, 350)
})

function pickResult(result) {
  listOpen.value = false
  query.value = ''
  results.value = []
  setStart(result.lngLat, result.label, { fly: true })
}

const range = computed(() => {
  const r = RANGES[store.mode]
  return store.targetType === 'distance' ? r.km : r.min
})

const sliderValue = computed({
  get: () =>
    store.targetType === 'distance'
      ? store.km[store.mode]
      : store.minutes[store.mode],
  set: (v) => {
    if (store.targetType === 'distance') store.km[store.mode] = Number(v)
    else store.minutes[store.mode] = Number(v)
  },
})

const sliderFill = computed(() => {
  const { min, max } = range.value
  return ((sliderValue.value - min) / (max - min)) * 100
})

function formatMinutes(min) {
  const h = Math.floor(min / 60)
  const m = Math.round(min % 60)
  const sp = locale.value === 'ja' ? '' : ' ' // Japanese sets no space before units
  if (!h) return `${m}${sp}${t('minAbbr')}`
  return m
    ? `${h}${sp}${t('hourAbbr')}${sp}${m}${sp}${t('minAbbr')}`
    : `${h}${sp}${t('hourAbbr')}`
}

const targetLabel = computed(() =>
  store.targetType === 'distance'
    ? `${store.km[store.mode].toLocaleString(undefined, { maximumFractionDigits: 1 })} km`
    : formatMinutes(store.minutes[store.mode]),
)

const targetHint = computed(() => {
  if (store.targetType !== 'distance') return `≈ ${localNumber(targetKm(), 1)} km`
  const duration = formatMinutes((store.km[store.mode] / SPEEDS[store.mode]) * 60)
  const mode = store.mode === 'bike' ? t('approxRide') : t('approxWalk')
  return locale.value === 'ja'
    ? `≈ ${mode}${duration}`
    : `≈ ${duration} ${mode}`
})

function onStartNavigation() {
  // Must happen inside the tap itself for iOS to allow speech later.
  primeSpeech()
  const started = startNavigation(store.route, {
    mode: store.mode,
    nature: store.nature,
  })
  if (!started) showError('errNoGeo')
}

const routeStats = computed(() => {
  if (!store.route) return null
  return {
    distance: `${localNumber(store.route.distanceKm, 1)} km`,
    duration: formatMinutes(store.route.durationSec / 60),
  }
})
</script>

<template>
  <section ref="panelEl" class="panel" :class="{ collapsed }" aria-label="Route planner">
    <div class="sheet-top">
      <button
        class="sheet-handle"
        :aria-expanded="!collapsed"
        :aria-label="t('panelToggle')"
        @click="collapsed = !collapsed"
        @touchstart.passive="onHandleTouchStart"
        @touchmove.passive="onHandleTouchMove"
        @touchend="onHandleTouchEnd"
        @touchcancel="onHandleTouchEnd"
      >
        <span class="grabber" aria-hidden="true"></span>
        <span v-if="collapsed && routeStats" class="mini-stats">
          {{ routeStats.distance }} · {{ routeStats.duration }}
        </span>
      </button>
      <!-- The sheet collapses as soon as a route lands, so starting must not
           require digging the result card back out. -->
      <button v-if="collapsed && routeStats" class="mini-start" @click="onStartNavigation">
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.5 11.5 21 4l-7.5 17.5-2-7.5z" fill="currentColor" />
        </svg>
        {{ t('navStart') }}
      </button>
    </div>

    <div class="sheet-body">
    <header class="brand">
      <svg class="brand-mark" viewBox="0 0 48 48" aria-hidden="true">
        <circle
          cx="24" cy="24" r="15"
          fill="none" stroke="url(#brand-g)" stroke-width="7"
          stroke-linecap="round" stroke-dasharray="70 25"
          transform="rotate(120 24 24)"
        />
        <circle cx="24" cy="39" r="5" fill="var(--ink)" />
        <defs>
          <linearGradient id="brand-g" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stop-color="var(--accent-1)" />
            <stop offset="1" stop-color="var(--accent-2)" />
          </linearGradient>
        </defs>
      </svg>
      <div class="brand-text">
        <h1>Meguri</h1>
        <p>{{ t('tagline') }}</p>
      </div>
      <div class="lang" role="radiogroup" aria-label="Language / Taal / 言語">
        <button
          v-for="code in LOCALES"
          :key="code"
          role="radio"
          :aria-checked="locale === code"
          :class="{ active: locale === code }"
          @click="setLocale(code)"
        >
          {{ code === 'ja' ? '日本語' : code.toUpperCase() }}
        </button>
      </div>
    </header>

    <div class="seg" role="radiogroup" :aria-label="t('activity')">
      <div
        class="seg-thumb"
        :style="{ transform: `translateX(${store.mode === 'bike' ? '100%' : '0'})` }"
      ></div>
      <button
        role="radio"
        :aria-checked="store.mode === 'walk'"
        :class="{ active: store.mode === 'walk' }"
        @click="store.mode = 'walk'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M13.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM9.8 8.9 7 23h2.1l1.8-8 2.1 2v6h2v-7.5l-2.1-2 .6-3C14.8 12 16.8 13 19 13v-2c-1.9 0-3.5-1-4.3-2.4l-1-1.6c-.4-.6-1-1-1.7-1-.3 0-.5.1-.8.1L6 8.3V13h2V9.6l1.8-.7"/>
        </svg>
        {{ t('walk') }}
      </button>
      <button
        role="radio"
        :aria-checked="store.mode === 'bike'"
        :class="{ active: store.mode === 'bike' }"
        @click="store.mode = 'bike'"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path fill="currentColor" d="M15.5 5.5c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zM5 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5zm5.8-10 2.4-2.4.8.8c1.3 1.3 3 2.1 5.1 2.1V9c-1.5 0-2.7-.6-3.6-1.5l-1.9-1.9c-.5-.4-1-.6-1.6-.6s-1.1.2-1.4.6L7.8 8.4c-.4.4-.6.9-.6 1.4 0 .6.2 1.1.6 1.4L11 14v5h2v-6.2l-2.2-2.3zM19 12c-2.8 0-5 2.2-5 5s2.2 5 5 5 5-2.2 5-5-2.2-5-5-5zm0 8.5c-1.9 0-3.5-1.6-3.5-3.5s1.6-3.5 3.5-3.5 3.5 1.6 3.5 3.5-1.6 3.5-3.5 3.5z"/>
        </svg>
        {{ t('bike') }}
      </button>
    </div>

    <div class="field-group">
      <label class="label" for="start-search">{{ t('startingPoint') }}</label>
      <div class="search-row">
        <div class="search-box">
          <svg viewBox="0 0 20 20" class="search-icon" aria-hidden="true">
            <circle cx="9" cy="9" r="6" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="m13.5 13.5 4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
          <input
            id="start-search"
            v-model="query"
            type="search"
            :placeholder="t('searchPlaceholder')"
            autocomplete="off"
            role="combobox"
            :aria-expanded="listOpen"
            aria-controls="search-results"
            @focus="listOpen = results.length > 0"
            @keydown.escape="listOpen = false"
          />
          <ul v-if="listOpen" id="search-results" class="results" role="listbox">
            <li v-for="r in results" :key="r.detail" role="option">
              <button @click="pickResult(r)">
                <strong>{{ r.label }}</strong>
                <small>{{ r.detail }}</small>
              </button>
            </li>
          </ul>
        </div>
        <button
          class="icon-btn"
          :title="t('useMyLocation')"
          :aria-label="t('useMyLocation')"
          @click="locate"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2" fill="currentColor" />
            <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" stroke-width="2" />
            <path d="M12 1.5v3.5M12 19v3.5M22.5 12H19M5 12H1.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>
        </button>
      </div>

      <p v-if="store.start" class="start-chip">
        <span class="dot" aria-hidden="true"></span>
        {{ store.start.label }}
      </p>
      <p v-else class="hint">{{ t('tapMapHint') }}</p>
    </div>

    <div class="field-group">
      <div class="label-row">
        <span class="label">{{ t('howFar') }}</span>
        <div class="mini-seg" role="radiogroup" :aria-label="t('targetBy')">
          <button
            role="radio"
            :aria-checked="store.targetType === 'distance'"
            :class="{ active: store.targetType === 'distance' }"
            @click="store.targetType = 'distance'"
          >
            {{ t('km') }}
          </button>
          <button
            role="radio"
            :aria-checked="store.targetType === 'time'"
            :class="{ active: store.targetType === 'time' }"
            @click="store.targetType = 'time'"
          >
            {{ t('time') }}
          </button>
        </div>
      </div>

      <div class="target">
        <output class="target-value" for="target-slider">{{ targetLabel }}</output>
        <span class="target-hint">{{ targetHint }}</span>
      </div>
      <input
        id="target-slider"
        v-model="sliderValue"
        class="slider"
        type="range"
        :min="range.min"
        :max="range.max"
        :step="range.step"
        :style="{ '--fill': sliderFill + '%' }"
        :aria-label="store.targetType === 'distance' ? t('distanceAria') : t('durationAria')"
      />
    </div>

    <button class="cta" :disabled="store.busy" @click="generate()">
      <span v-if="store.busy" class="spinner" aria-hidden="true"></span>
      <span>{{ store.busy ? t('plotting') : store.route ? t('regenerateRoute') : t('createRoute') }}</span>
    </button>

    <label class="nature-row">
      <svg class="nature-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3c-4 3.2-6.5 5-6.5 9a6.5 6.5 0 0 0 13 0c0-4-2.5-5.8-6.5-9z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
        <path d="M12 21v-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
      </svg>
      <span class="nature-text">
        <strong>{{ t('natureLabel') }}</strong>
        <small>{{ store.nature ? t('natureOn') : t('natureOff') }}</small>
      </span>
      <input
        class="switch"
        type="checkbox"
        role="switch"
        :checked="store.nature"
        @change="setNature($event.target.checked)"
      />
    </label>

    <p class="quiet-note">{{ t('quietNote') }}</p>

    <Transition name="rise">
      <div v-if="routeStats" class="result-card">
        <div class="stats">
          <div class="stat">
            <span class="stat-value">{{ routeStats.distance }}</span>
            <span class="stat-label">{{ t('distance') }}</span>
          </div>
          <div class="stat">
            <span class="stat-value">{{ routeStats.duration }}</span>
            <span class="stat-label">{{ store.mode === 'bike' ? t('estRideTime') : t('estWalkTime') }}</span>
          </div>
        </div>
        <button class="nav-cta" @click="onStartNavigation">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3.5 11.5 21 4l-7.5 17.5-2-7.5z" fill="currentColor" />
          </svg>
          {{ t('navStart') }}
        </button>

        <div class="result-actions">
          <button class="ghost-btn" :disabled="store.busy" @click="generate({ shuffle: true })">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 6h3.5c5 0 5.5 8 10.5 8H21M4 18h3.5c1.9 0 3.1-1.1 4.1-2.4M21 6h-3c-1.9 0-3.1 1.1-4.1 2.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
              <path d="m18.5 3.5 3 2.5-3 2.5M18.5 11.5l3 2.5-3 2.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ t('surpriseMe') }}
          </button>
          <button class="ghost-btn" @click="downloadGpx(store.route, store.mode)">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 3v11m0 0 -4 -4m4 4 4-4M4.5 20h15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
            {{ t('gpx') }}
          </button>
        </div>
      </div>
    </Transition>
    </div>
  </section>
</template>

<style scoped>
.panel {
  position: absolute;
  z-index: 10;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow);
  /* iOS drops backdrop-filter mid-transform when it sits on the animated
     element itself, so the blur lives on a static pseudo-element instead. */
  background: transparent;
  isolation: isolate;
}

.panel::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  background: var(--surface);
  backdrop-filter: blur(24px) saturate(1.6);
  -webkit-backdrop-filter: blur(24px) saturate(1.6);
}

.sheet-body {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 22px;
}

@media (min-width: 761px) {
  .panel {
    top: 20px;
    left: 20px;
    width: 400px;
    max-height: calc(100dvh - 40px);
    overflow-y: auto;
    border-radius: var(--radius);
  }
}

.sheet-top {
  display: none;
}

.panel {
  --handle-h: 58px;
}

@media (max-width: 760px) {
  .panel {
    left: 0;
    right: 0;
    bottom: 0;
    /* The sheet is always full height; collapsing slides it down so the
       handle strip stays put. No scroll-position coupling, no lost handle. */
    max-height: 78dvh;
    overflow: visible;
    border-radius: var(--radius) var(--radius) 0 0;
    transition: transform 0.42s cubic-bezier(0.3, 1, 0.3, 1);
    will-change: transform;
  }

  .panel.collapsed {
    transform: translateY(calc(100% - var(--handle-h)));
  }

  /* While a finger holds the sheet, it must sit exactly under it. */
  .panel.dragging {
    transition: none;
  }

  .sheet-body {
    /* Only the body scrolls, so the handle can never scroll out of view. */
    max-height: calc(78dvh - var(--handle-h));
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    padding-top: 4px;
    padding-bottom: calc(22px + env(safe-area-inset-bottom));
  }

  .sheet-top {
    display: flex;
    align-items: center;
    flex: none;
    height: var(--handle-h);
  }

  .sheet-handle {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    flex: 1;
    align-self: stretch;
    min-width: 0;
    -webkit-tap-highlight-color: transparent;
    touch-action: none;
  }

  .mini-start {
    display: flex;
    align-items: center;
    gap: 7px;
    flex: none;
    margin-right: 12px;
    padding: 10px 16px;
    border-radius: 12px;
    font-size: 14.5px;
    font-weight: 700;
    color: #fff;
    background: linear-gradient(100deg, var(--accent-1), var(--accent-2));
    box-shadow: 0 6px 16px -6px var(--accent-1);
  }

  .mini-start svg {
    width: 16px;
    height: 16px;
  }

  .grabber {
    width: 42px;
    height: 4.5px;
    border-radius: 99px;
    background: var(--ink-3);
    opacity: 0.55;
  }

  .mini-stats {
    font-size: 14.5px;
    font-weight: 700;
    letter-spacing: -0.01em;
    font-variant-numeric: tabular-nums;
    background: linear-gradient(100deg, var(--accent-1), var(--accent-2));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }

  @media (prefers-reduced-motion: reduce) {
    .panel {
      transition: none;
    }
  }
}

/* ---- brand ---- */
.brand {
  display: flex;
  align-items: center;
  gap: 13px;
}

.brand-mark {
  width: 42px;
  height: 42px;
  flex: none;
}

.brand-text {
  flex: 1;
  min-width: 0;
}

.brand h1 {
  margin: 0;
  font-size: 22px;
  font-weight: 700;
  letter-spacing: -0.02em;
}

.brand p {
  margin: 1px 0 0;
  font-size: 13px;
  color: var(--ink-3);
}

.lang {
  display: flex;
  gap: 2px;
  background: var(--field);
  padding: 3px;
  border-radius: 9px;
  align-self: flex-start;
}

.lang button {
  padding: 3px 7px;
  border-radius: 7px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  white-space: nowrap;
  color: var(--ink-3);
  transition: all 0.18s;
}

.lang button.active {
  background: var(--surface-solid);
  color: var(--ink);
  box-shadow: 0 1px 4px rgba(12, 17, 27, 0.14);
}

/* ---- segmented control ---- */
.seg {
  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  background: var(--field);
  border-radius: 14px;
  padding: 4px;
}

.seg-thumb {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc(50% - 4px);
  border-radius: 11px;
  background: var(--surface-solid);
  box-shadow: 0 2px 8px rgba(12, 17, 27, 0.14);
  transition: transform 0.28s cubic-bezier(0.3, 1.3, 0.4, 1);
}

.seg button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 10px 0;
  border-radius: 11px;
  font-weight: 600;
  font-size: 15px;
  color: var(--ink-3);
  transition: color 0.2s;
}

.seg button svg {
  width: 19px;
  height: 19px;
}

.seg button.active {
  color: var(--ink);
}

.seg button.active svg {
  color: var(--accent-1);
}

/* ---- fields ---- */
.field-group {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.label {
  font-size: 12.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--ink-3);
}

.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* ---- search ---- */
.search-row {
  display: flex;
  gap: 9px;
}

.search-box {
  position: relative;
  flex: 1;
}

.search-icon {
  position: absolute;
  left: 13px;
  top: 50%;
  translate: 0 -50%;
  width: 17px;
  height: 17px;
  color: var(--ink-3);
  pointer-events: none;
}

.search-box input {
  width: 100%;
  padding: 12px 14px 12px 40px;
  border: 1px solid transparent;
  border-radius: 13px;
  background: var(--field);
  font-size: 15px;
  transition: background 0.2s, border-color 0.2s;
}

.search-box input:focus {
  outline: none;
  background: var(--field-focus);
  border-color: var(--accent-1);
}

.search-box input::-webkit-search-cancel-button {
  -webkit-appearance: none;
}

.results {
  position: absolute;
  z-index: 20;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  margin: 0;
  padding: 6px;
  list-style: none;
  background: var(--surface-solid);
  border: 1px solid var(--hairline);
  border-radius: 14px;
  box-shadow: var(--shadow);
  max-height: 240px;
  overflow-y: auto;
}

.results button {
  display: flex;
  flex-direction: column;
  gap: 1px;
  width: 100%;
  text-align: left;
  padding: 9px 11px;
  border-radius: 9px;
}

.results button:hover,
.results button:focus-visible {
  background: var(--accent-soft);
}

.results strong {
  font-size: 14px;
  font-weight: 600;
}

.results small {
  font-size: 12px;
  color: var(--ink-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.icon-btn {
  flex: none;
  width: 46px;
  border-radius: 13px;
  background: var(--field);
  display: grid;
  place-items: center;
  color: var(--ink-2);
  transition: background 0.2s, color 0.2s;
}

.icon-btn:hover {
  background: var(--accent-soft);
  color: var(--accent-1);
}

.icon-btn svg {
  width: 21px;
  height: 21px;
}

.start-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13.5px;
  font-weight: 500;
  color: var(--ink-2);
}

.start-chip .dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
}

.hint {
  margin: 0;
  font-size: 13px;
  color: var(--ink-3);
}

/* ---- mini segmented (km / time) ---- */
.mini-seg {
  display: flex;
  gap: 2px;
  background: var(--field);
  padding: 3px;
  border-radius: 9px;
}

.mini-seg button {
  padding: 4px 12px;
  border-radius: 7px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-3);
  transition: all 0.18s;
}

.mini-seg button.active {
  background: var(--surface-solid);
  color: var(--ink);
  box-shadow: 0 1px 4px rgba(12, 17, 27, 0.14);
}

/* ---- target ---- */
.target {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.target-value {
  font-size: 34px;
  font-weight: 700;
  letter-spacing: -0.03em;
  background: linear-gradient(100deg, var(--accent-1), var(--accent-2));
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  font-variant-numeric: tabular-nums;
}

.target-hint {
  font-size: 13.5px;
  color: var(--ink-3);
}

/* ---- slider ---- */
.slider {
  appearance: none;
  -webkit-appearance: none;
  width: 100%;
  height: 8px;
  border-radius: 99px;
  background:
    linear-gradient(90deg, var(--accent-1), var(--accent-2)) 0 0 / var(--fill) 100% no-repeat,
    var(--field);
  cursor: pointer;
}

.slider::-webkit-slider-thumb {
  appearance: none;
  -webkit-appearance: none;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: #fff;
  border: 2.5px solid var(--accent-1);
  box-shadow: 0 2px 8px rgba(12, 17, 27, 0.28);
  transition: transform 0.15s;
}

.slider::-webkit-slider-thumb:active {
  transform: scale(1.18);
}

.slider::-moz-range-thumb {
  width: 21px;
  height: 21px;
  border-radius: 50%;
  background: #fff;
  border: 2.5px solid var(--accent-1);
  box-shadow: 0 2px 8px rgba(12, 17, 27, 0.28);
}

/* ---- CTA ---- */
.cta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 15px;
  border-radius: 15px;
  font-size: 16px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(100deg, var(--accent-1), var(--accent-2));
  box-shadow: 0 8px 22px -6px var(--accent-1);
  transition: transform 0.15s, box-shadow 0.2s, filter 0.2s;
}

.cta:hover:not(:disabled) {
  transform: translateY(-1px);
  filter: brightness(1.06);
}

.cta:active:not(:disabled) {
  transform: translateY(0);
}

.cta:disabled {
  opacity: 0.75;
  cursor: default;
}

.spinner {
  width: 17px;
  height: 17px;
  border-radius: 50%;
  border: 2.5px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(1turn);
  }
}

.quiet-note {
  margin: -10px 0 0;
  font-size: 12px;
  color: var(--ink-3);
  text-align: center;
}

/* ---- nature toggle ---- */
.nature-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 13px 15px;
  border-radius: 15px;
  background: var(--field);
  cursor: pointer;
  transition: background 0.2s;
}

.nature-row:has(.switch:checked) {
  background: var(--accent-soft);
}

.nature-icon {
  flex: none;
  width: 21px;
  height: 21px;
  color: var(--ink-3);
  transition: color 0.2s;
}

.nature-row:has(.switch:checked) .nature-icon {
  color: var(--accent-1);
}

.nature-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

.nature-text strong {
  font-size: 14.5px;
  font-weight: 600;
}

.nature-text small {
  font-size: 12px;
  color: var(--ink-3);
}

.switch {
  appearance: none;
  -webkit-appearance: none;
  flex: none;
  width: 46px;
  height: 27px;
  margin: 0;
  border-radius: 99px;
  background: var(--hairline);
  position: relative;
  cursor: pointer;
  transition: background 0.24s;
}

.switch::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 21px;
  height: 21px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 4px rgba(12, 17, 27, 0.35);
  transition: transform 0.24s cubic-bezier(0.3, 1.3, 0.4, 1);
}

.switch:checked {
  background: linear-gradient(100deg, var(--accent-1), var(--accent-2));
}

.switch:checked::after {
  transform: translateX(19px);
}

/* ---- result ---- */
.result-card {
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px;
  border-radius: 17px;
  background: var(--accent-soft);
  border: 1px solid var(--hairline);
}

.stats {
  display: flex;
  gap: 26px;
}

.stat {
  display: flex;
  flex-direction: column;
}

.stat-value {
  font-size: 21px;
  font-weight: 700;
  letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums;
}

.stat-label {
  font-size: 12px;
  color: var(--ink-3);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.nav-cta {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  padding: 13px;
  border-radius: 14px;
  font-size: 15.5px;
  font-weight: 700;
  color: #fff;
  background: linear-gradient(100deg, var(--accent-1), var(--accent-2));
  box-shadow: 0 8px 22px -6px var(--accent-1);
  transition: transform 0.15s, filter 0.2s;
}

.nav-cta:hover {
  transform: translateY(-1px);
  filter: brightness(1.06);
}

.nav-cta svg {
  width: 18px;
  height: 18px;
}

.result-actions {
  display: flex;
  gap: 9px;
}

.ghost-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  border-radius: 11px;
  background: var(--surface-solid);
  border: 1px solid var(--hairline);
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink-2);
  transition: color 0.2s, border-color 0.2s, transform 0.15s;
}

.ghost-btn:hover:not(:disabled) {
  color: var(--accent-1);
  border-color: var(--accent-1);
  transform: translateY(-1px);
}

.ghost-btn svg {
  width: 16px;
  height: 16px;
}

.rise-enter-active {
  transition: opacity 0.35s, transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2);
}

.rise-enter-from {
  opacity: 0;
  transform: translateY(10px);
}
</style>
