import { ref } from 'vue'
import { renderRouteMap } from '../infra/print-map'
import type { Route } from '../domain/route'

/**
 * Printing a knooppuntenroute: a folded A4. The strip of numbers on one
 * half, the route on a map on the other; folded with the print outward, the
 * numbers are the front and opening it is the map.
 *
 * The map has to be a picture before the print dialog opens, so this
 * renders it first and prints after. PrintStrip.vue reads both refs.
 */

// Half an A4 landscape side inside the margins, in CSS pixels at 96 dpi:
// about 134 by 194 mm.
const PANEL_PX = { width: 506, height: 733 }

export const printImage = ref('')
export const printing = ref(false)

export async function printKnooppunten(route: Route) {
  if (printing.value) return
  printing.value = true
  try {
    printImage.value = await renderRouteMap(route, PANEL_PX)
  } catch {
    // No WebGL, tiles unreachable: the strip still prints, the map panel
    // carries the sequence in words instead.
    printImage.value = ''
  } finally {
    printing.value = false
  }
  // Let the image land in the DOM before the dialog snapshots the page.
  await new Promise((r) => requestAnimationFrame(() => r(null)))
  window.print()
}
