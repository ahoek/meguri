<script setup lang="ts">
import { computed } from 'vue'
import { store } from '../app/store'
import { locale, t } from '../i18n'
import { localNumber } from '../domain/format'

/**
 * The knooppuntenstrookje: the strip of numbers Dutch riders tape to the
 * stem, with the distance to each next one, so the ride can be followed
 * from the signs with the phone in the pocket. Nothing on screen; it is
 * what the page becomes when printed, and only when there is a
 * knooppuntenroute to print.
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

const today = computed(() =>
  new Date().toLocaleDateString(locale.value, { day: 'numeric', month: 'long', year: 'numeric' }),
)
</script>

<template>
  <section v-if="steps.length" class="knp-print" aria-hidden="true">
    <header>
      <h1>{{ t('knpLabel') }}</h1>
      <p class="meta">{{ total }} · {{ store.start?.label }} · {{ today }}</p>
      <p class="sequence">{{ steps.map((s) => s.ref).join(' › ') }}</p>
    </header>

    <ol class="strip">
      <li class="cell connector">
        <span class="word">{{ t('startingPoint') }}</span>
        <span class="dist">↓ {{ toFirst }}</span>
      </li>
      <li v-for="(step, i) in steps" :key="i" class="cell">
        <span class="badge">{{ step.ref }}</span>
        <span class="dist">↓ {{ step.toNext }}</span>
      </li>
      <li class="cell connector">
        <span class="word">{{ t('nav_finish') }}</span>
      </li>
    </ol>

    <footer>Meguri · {{ t('knpHint') }}</footer>
  </section>
</template>

<style scoped>
.knp-print {
  display: none;
}

@media print {
  .knp-print {
    display: block;
    padding: 12mm;
    color: #000;
    background: #fff;
    font-family: var(--font);
  }

  h1 {
    margin: 0 0 2mm;
    font-size: 20pt;
    font-weight: 800;
  }

  .meta {
    margin: 0 0 3mm;
    font-size: 11pt;
    color: #333;
  }

  .sequence {
    margin: 0 0 8mm;
    font-size: 13pt;
    font-weight: 700;
    color: #047857;
    word-spacing: 0.15em;
  }

  /* Cut along the edge: a narrow column that fits a stem, several to a page
     for long rides. */
  .strip {
    display: grid;
    grid-template-columns: repeat(auto-fill, 34mm);
    gap: 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .cell {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 3mm 0 2mm;
    border: 0.3mm dashed #999;
    margin: 0 -0.3mm -0.3mm 0;
    break-inside: avoid;
  }

  .badge {
    display: grid;
    place-items: center;
    min-width: 16mm;
    height: 14mm;
    padding: 0 3mm;
    border: 1mm solid #047857;
    border-radius: 3mm;
    color: #047857;
    font-size: 22pt;
    font-weight: 800;
    font-variant-numeric: tabular-nums;
  }

  .word {
    display: grid;
    place-items: center;
    height: 14mm;
    padding: 0 2mm;
    font-size: 10pt;
    font-weight: 700;
    text-align: center;
    color: #333;
  }

  .dist {
    margin-top: 1.5mm;
    font-size: 10pt;
    font-weight: 600;
    color: #333;
    font-variant-numeric: tabular-nums;
  }

  footer {
    margin-top: 8mm;
    font-size: 9pt;
    color: #666;
  }
}
</style>
