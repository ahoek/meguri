import { ref } from 'vue'
import { renderRouteMap } from '../infra/print-map'
import type { Route } from '../domain/route'

/**
 * Printing a knooppuntenroute: an A4 folded twice. The route on a map on
 * the top half, an A5 landscape; the strip of numbers on an A6 cover below
 * it, printed upside down so that folding the bottom half up behind the map
 * and then folding in half leaves the numbers as the front and the map as
 * what opens.
 *
 * The map has to be a picture before the print dialog opens, so this
 * renders it first and prints after. PrintStrip.vue reads both refs.
 */

// The top half of an A4 portrait sheet inside its margins, an A5 landscape
// of about 194 by 133 mm, in CSS pixels at 96 dpi.
const PANEL_PX = { width: 733, height: 502 }

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
