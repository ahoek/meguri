<script setup lang="ts">
import { defineAsyncComponent, onMounted, ref, watchEffect } from 'vue'
import ControlPanel from './components/ControlPanel.vue'
import { store, resumeSession } from './app/store'
import { nav } from './app/nav-session'
import { locale, t } from './i18n'

/**
 * The map arrives a moment after the planner, on purpose.
 *
 * MapLibre is a megabyte of JavaScript and seventy kilobytes of CSS, and while
 * it was imported statically every byte of it stood between a cold visit and
 * the first thing on screen — parsed and compiled before Vue could mount, on
 * phone silicon, over whatever connection the walker has outdoors. None of it
 * is needed to draw the planner, which is the whole of what you see first and
 * the only part you can act on: pick a distance, name a place, press a button.
 *
 * The map is not delayed by much and loses nothing by it — its canvas opens
 * empty either way and stays empty until tiles arrive over the same
 * connection. What it stops doing is holding the planner hostage while it
 * loads.
 */
const MapView = defineAsyncComponent(() => import('./components/MapView.vue'))

// The async wrapper resolves the ref to the inner component, so Recenter still
// reaches the real thing — but only once the chunk is in, hence the optional
// call at the template.
const mapView = ref<{ recenter: () => void } | null>(null)

// Navigation is a mode you enter, not a screen you land on: its panel, and the
// speech and compass plumbing behind it, follow the same reasoning as the map.
const NavPanel = defineAsyncComponent(() => import('./components/NavPanel.vue'))

watchEffect(() => {
  document.documentElement.dataset.mode = store.mode
  document.documentElement.lang = locale.value
})

onMounted(resumeSession)
</script>

<template>
  <main class="app">
    <MapView ref="mapView" />
    <ControlPanel v-if="!nav.active" />
    <NavPanel v-if="nav.active" @recenter="mapView?.recenter()" />
    <Transition name="toast">
      <div v-if="store.error" class="toast" role="alert">{{ t(store.error) }}</div>
    </Transition>
  </main>
</template>

<style scoped>
.app {
  position: relative;
  height: 100%;
  overflow: hidden;
}

.toast {
  position: absolute;
  z-index: 30;
  top: calc(16px + env(safe-area-inset-top));
  left: 50%;
  translate: -50% 0;
  max-width: min(90vw, 420px);
  padding: 12px 18px;
  border-radius: 14px;
  background: var(--surface);
  backdrop-filter: blur(20px) saturate(1.6);
  -webkit-backdrop-filter: blur(20px) saturate(1.6);
  border: 1px solid var(--hairline);
  box-shadow: var(--shadow);
  font-size: 14px;
  font-weight: 500;
  text-align: center;
}

@media (max-width: 760px) {
  .toast {
    top: calc(12px + env(safe-area-inset-top));
  }
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.3s, translate 0.3s;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  translate: -50% -12px;
}
</style>
