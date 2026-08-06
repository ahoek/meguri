import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store } from '../app/store'

/**
 * The mobile bottom sheet: collapse to a slim bar so the route stays visible.
 *
 * The sheet tracks the finger while dragging and snaps on release, judged by
 * flick velocity first and position second — the fixed-threshold swipe it
 * replaces ignored both, which is what made it feel non-native.
 *
 * The whole panel is the drag surface, not just the grabber — a sheet you can
 * only move by a 30-pixel strip fails the first thing anyone tries. What made
 * that hard is that the sheet's body scrolls, so a vertical gesture is
 * ambiguous, and the arbitration below is the whole feature:
 *
 * - Nothing is claimed until the finger has clearly moved, and a mostly
 *   horizontal gesture is never claimed — that is the distance slider being
 *   used, not the sheet being thrown away.
 * - Collapsed, every vertical drag is the sheet's: nothing else is visible.
 * - Expanded, a drag that starts in the scrolling body belongs to the body
 *   whenever the body could consume it — content above when dragging down,
 *   content below when dragging up. Only at the ends does the sheet take
 *   over, which is exactly how a native sheet feels.
 * - Once claimed, the gesture is claimed for good and the page must not also
 *   scroll — hence the non-passive listener and the `preventDefault`.
 */

const isMobile = () => matchMedia('(max-width: 760px)').matches

// A finger has to travel this far before the gesture means anything.
const SLOP_PX = 8

interface SheetDrag {
  startY: number
  startX: number
  base: number
  offset: number | null
  lastY: number
  lastT: number
  velocity: number
  /** null: undecided · true: the sheet's gesture · false: someone else's */
  claimed: boolean | null
  scroller: HTMLElement | null
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

  function onSheetTouchStart(e: TouchEvent) {
    if (!isMobile()) return
    const target = e.target as HTMLElement | null
    // The slider owns its own drags entirely; taking the vertical component
    // while a thumb is being held makes both feel broken.
    if (target?.closest('input[type="range"]')) return

    drag = {
      startY: e.touches[0].clientY,
      startX: e.touches[0].clientX,
      base: collapsed.value ? collapsedOffset() : 0,
      offset: null,
      lastY: e.touches[0].clientY,
      lastT: performance.now(),
      velocity: 0,
      claimed: null,
      scroller: (target?.closest('.sheet-body') as HTMLElement | null) ?? null,
    }
  }

  /** Whose gesture is this? Decided once, at the first real movement. */
  function adjudicate(d: SheetDrag, dx: number, dy: number): boolean {
    if (Math.abs(dx) > Math.abs(dy)) return false // horizontal: not ours
    if (collapsed.value) return true // nothing else to give it to
    if (!d.scroller) return true // header, grabber, buttons strip
    const { scrollTop, scrollHeight, clientHeight } = d.scroller
    if (dy > 0) return scrollTop <= 0 // down: ours only at the very top
    return scrollTop + clientHeight >= scrollHeight - 1 // up: ours at the end
  }

  function onSheetTouchMove(e: TouchEvent) {
    if (!drag) return
    const y = e.touches[0].clientY
    const x = e.touches[0].clientX

    if (drag.claimed == null) {
      const dy = y - drag.startY
      const dx = x - drag.startX
      if (Math.abs(dy) < SLOP_PX && Math.abs(dx) < SLOP_PX) return
      drag.claimed = adjudicate(drag, dx, dy)
      if (!drag.claimed) return
      // Claimed from mid-gesture: measure the drag from here, not from the
      // touch, or the sheet jumps by the slop already travelled.
      drag.startY = y
      drag.lastY = y
      drag.lastT = performance.now()
      panelEl.value?.classList.add('dragging')
    }
    if (!drag.claimed) return

    // Ours: the body must not scroll under the moving sheet.
    e.preventDefault()

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

  function onSheetTouchEnd(e: TouchEvent) {
    if (!drag) return
    const d = drag
    drag = null
    if (!d.claimed) return // a tap, a scroll, a slider move — not ours to end
    panelEl.value?.classList.remove('dragging')
    if (panelEl.value) panelEl.value.style.transform = ''
    // Barely moved: it's a tap, and the click handler will toggle.
    if (d.offset == null || Math.abs(d.lastY - d.startY) < 6) return
    if (e.cancelable) e.preventDefault() // a real drag must not also fire the click toggle
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
    onSheetTouchStart,
    onSheetTouchMove,
    onSheetTouchEnd,
  }
}
