import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store } from '../app/store'

/**
 * The mobile bottom sheet: collapse to a slim bar so the route stays visible.
 *
 * The sheet tracks the finger while dragging and snaps on release, judged by
 * flick velocity first and position second — the fixed-threshold swipe it
 * replaces ignored both, which is what made it feel non-native.
 */

const isMobile = () => matchMedia('(max-width: 760px)').matches

interface SheetDrag {
  startY: number
  base: number
  offset: number | null
  lastY: number
  lastT: number
  velocity: number
}

export function useBottomSheet() {
  const collapsed = ref(false)
  const panelEl = ref<HTMLElement | null>(null)
  const sheetTopEl = ref<HTMLElement | null>(null)

  // The strip grows by the home-indicator clearance on phones with rounded
  // corners, so measure it rather than assuming the base height.
  const handleH = () => sheetTopEl.value?.offsetHeight ?? 30
  const collapsedOffset = () => (panelEl.value?.offsetHeight ?? 0) - handleH()

  let drag: SheetDrag | null = null

  function onHandleTouchStart(e: TouchEvent) {
    drag = {
      startY: e.touches[0].clientY,
      base: collapsed.value ? collapsedOffset() : 0,
      offset: null,
      lastY: e.touches[0].clientY,
      lastT: performance.now(),
      velocity: 0,
    }
    panelEl.value?.classList.add('dragging')
  }

  function onHandleTouchMove(e: TouchEvent) {
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
    if (panelEl.value) panelEl.value.style.transform = `translateY(${offset}px)`
  }

  function onHandleTouchEnd(e: TouchEvent) {
    if (!drag) return
    const d = drag
    drag = null
    panelEl.value?.classList.remove('dragging')
    if (panelEl.value) panelEl.value.style.transform = ''
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
      ? handleH()
      : (panelEl.value?.offsetHeight ?? handleH())
  }

  watch(collapsed, publishInset)

  let insetObserver: ResizeObserver | null = null
  onMounted(() => {
    publishInset()
    insetObserver = new ResizeObserver(publishInset)
    if (panelEl.value) insetObserver.observe(panelEl.value)
  })
  onBeforeUnmount(() => {
    insetObserver?.disconnect()
    store.sheetInset = 0
  })

  return {
    collapsed,
    panelEl,
    sheetTopEl,
    isMobile,
    onHandleTouchStart,
    onHandleTouchMove,
    onHandleTouchEnd,
  }
}
