<script setup lang="ts">
import { onMounted, ref, watchEffect } from 'vue'
import MapView from './components/MapView.vue'
import ControlPanel from './components/ControlPanel.vue'
import NavPanel from './components/NavPanel.vue'
import { store, resumeSession } from './app/store'
import { nav } from './app/nav-session'
import { locale, t } from './i18n'

const mapView = ref<InstanceType<typeof MapView> | null>(null)

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
