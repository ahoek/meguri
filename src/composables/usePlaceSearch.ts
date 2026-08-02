import { ref, watch } from 'vue'
import { searchPlaces } from '../infra/nominatim'
import { locale } from '../i18n'
import type { PlaceResult } from '../infra/nominatim'

/**
 * Debounced place lookup for the start-point box.
 *
 * Nominatim is shared community infrastructure, so a query goes out only
 * after the typing pauses, and any in-flight one is abandoned the moment the
 * text changes again.
 */

const DEBOUNCE_MS = 350
const MIN_QUERY = 3

export function usePlaceSearch() {
  const query = ref('')
  const results = ref<PlaceResult[]>([])
  const searching = ref(false)
  const listOpen = ref(false)

  let debounceTimer: ReturnType<typeof setTimeout> | undefined
  let abort: AbortController | null = null

  watch(query, (q) => {
    clearTimeout(debounceTimer)
    abort?.abort()
    if (q.trim().length < MIN_QUERY) {
      results.value = []
      listOpen.value = false
      return
    }
    debounceTimer = setTimeout(async () => {
      searching.value = true
      abort = new AbortController()
      try {
        results.value = await searchPlaces(q, abort.signal, locale.value)
        listOpen.value = results.value.length > 0
      } catch {
        /* aborted or offline — keep quiet */
      } finally {
        searching.value = false
      }
    }, DEBOUNCE_MS)
  })

  /** Chosen a result: close up and clear, the caller sets the start. */
  function reset() {
    listOpen.value = false
    query.value = ''
    results.value = []
  }

  return { query, results, searching, listOpen, reset }
}
