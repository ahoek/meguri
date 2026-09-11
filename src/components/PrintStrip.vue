<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../app/store'
import { printImage } from '../app/print'
import { locale, t } from '../i18n'
import { localNumber } from '../domain/format'

/**
 * A folded A4: on the right half the knooppuntenstrookje, the strip of
 * numbers Dutch riders tape to the stem with the distance to each next one;
 * on the left half the route on a map. Folded with the print outward the
 * numbers are the front, and opening it is the map. Nothing on screen; it
 * is what the page becomes when printed, and only when there is a
 * knooppuntenroute to print. The map is rendered by app/print.ts first.
 */

const junctions = computed(() => store.route?.junctions ?? [])

const km = (n: number) => `${localNumber(n, 1)} km`

const steps = computed(() => {
  const route = store.route
  const list = junctions.value
  if (!route || !list.length) return []
  return list.map((stop, i) => {
    const next = list[i + 1]
    const toNext = next ? next.atKm - stop.atKm : route.distanceKm - stop.atKm
    return { ref: stop.ref, toNext: km(Math.max(0, toNext)), last: !next }
  })
})

const toFirst = computed(() => km(junctions.value[0]?.atKm ?? 0))

const total = computed(() => {
  const route = store.route
  if (!route) return ''
  const minutes = Math.round(route.durationSec / 60)
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const sp = locale.value === 'ja' ? '' : ' '
  const time = h ? `${h}${sp}${t('hourAbbr')}${sp}${m}${sp}${t('minAbbr')}` : `${m}${sp}${t('minAbbr')}`
  return `${km(route.distanceKm)} · ${time}`
})

// Cells run down a column of eleven and on to the top of the next; the
// arrow points where the next number is. Index -1 is the start cell.
const ROWS = 11
const arrow = (i: number) => ((i + 2) % ROWS === 0 ? '↗' : '↓')

const today = computed(() =>
  new Date().toLocaleDateString(locale.value, { day: 'numeric', month: 'long', year: 'numeric' }),
)
</script>

<template>
  <!-- One A4 portrait sheet. Top half: the map, an A5 landscape. Bottom half:
       the two A6 covers, printed upside down. Fold the bottom half up behind
       the map, then fold in half: the numbers are the front, the map opens. -->
  <section v-if="steps.length" class="knp-print" aria-hidden="true">
    <div class="half map-half">
      <div class="map-frame">
        <img v-if="printImage" :src="printImage" alt="" />
      </div>
      <p class="credit">Meguri · © OpenStreetMap · OpenFreeMap</p>
    </div>

    <div class="half covers">
      <div class="quarter back">
        <h1>{{ t('knpLabel') }}</h1>
        <p class="meta">{{ total }}</p>
        <p class="meta">{{ store.start?.label }}</p>
        <p class="meta">{{ today }}</p>
        <p class="credit">Meguri · {{ t('knpHint') }}</p>
      </div>
      <div class="quarter front">
        <p class="title">{{ t('knpLabel') }} · {{ total }}</p>
        <ol class="strip">
          <li class="cell connector">
            <span class="word">{{ t('startingPoint') }}</span>
            <span class="dist">{{ arrow(-1) }} {{ toFirst }}</span>
          </li>
          <li v-for="(step, i) in steps" :key="i" class="cell">
            <span class="badge">{{ step.ref }}</span>
            <span class="dist">{{ arrow(i) }} {{ step.toNext }}</span>
          </li>
          <li class="cell connector">
            <span class="word">{{ t('nav_finish') }}</span>
          </li>
        </ol>
      </div>
    </div>
  </section>
</template>

<style scoped>
.knp-print {
  display: none;
}

/* The sheet itself, no printer margin: the folds fall on the halves and
   quarters of the paper, so the panels must too. Each panel keeps its own
   margin inside. */
@page {
  size: A4 portrait;
  margin: 0;
}

@media print {
  .knp-print {
    display: grid;
    grid-template-rows: 148.5mm 148.5mm;
    width: 210mm;
    height: 297mm;
    color: #000;
    background: #fff;
    font-family: var(--font);
  }

  .half {
    min-height: 0;
    break-inside: avoid;
  }

  /* ---- the map: an A5 landscape ---- */
  .map-half {
    display: flex;
    flex-direction: column;
    padding: 8mm 8mm 3mm;
    border-bottom: 0.3mm dashed #bbb;
  }

  .map-frame {
    position: relative;
    flex: 1;
    min-height: 0;
  }

  .map-frame img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    object-position: top left;
  }

  .credit {
    margin: 1.5mm 0 0;
    font-size: 7.5pt;
    color: #666;
  }

  /* ---- the covers: two A6 portraits, upside down ----
     Folded up behind the map they turn over twice, so they are printed
     turned over twice. In the turned grid the first quarter lands on the
     sheet's right: the back cover; the second on its left: the front. */
  .covers {
    display: grid;
    grid-template-columns: 105mm 105mm;
    transform: rotate(180deg);
  }

  .quarter {
    min-width: 0;
    padding: 8mm;
  }

  .back {
    border-right: 0.3mm dashed #bbb;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
  }

  h1 {
    margin: 0 0 2mm;
    font-size: 15pt;
    font-weight: 800;
  }

  .meta {
    margin: 0 0 1mm;
    font-size: 9pt;
    color: #333;
  }

  .back .credit {
    margin-top: 4mm;
  }

  .title {
    margin: 0 0 3mm;
    font-size: 9pt;
    font-weight: 700;
    color: #333;
  }

  /* Read down each column, then the next: the arrows say so. Eleven rows
     fill the cover; a long ride takes a fourth column, narrower. */
  .strip {
    display: grid;
    grid-auto-flow: column;
    grid-template-rows: repeat(11, 1fr);
    grid-auto-columns: 1fr;
    height: 118mm;
    margin: 0;
    padding: 0;
    list-style: none;
    font-variant-numeric: tabular-nums;
  }

  .cell {
    display: flex;
    align-items: center;
    gap: 1.5mm;
    min-width: 0;
    padding: 0 1mm;
  }

  .badge {
    display: grid;
    place-items: center;
    flex: none;
    min-width: 10mm;
    height: 8mm;
    padding: 0 1.5mm;
    border: 0.6mm solid #047857;
    border-radius: 2mm;
    color: #047857;
    font-size: 13pt;
    font-weight: 800;
  }

  .word {
    flex: none;
    font-size: 7.5pt;
    font-weight: 700;
    color: #333;
  }

  .dist {
    font-size: 8pt;
    font-weight: 600;
    color: #333;
    white-space: nowrap;
  }
}
</style>
