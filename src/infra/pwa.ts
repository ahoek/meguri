import { registerSW } from 'virtual:pwa-register'

// The service worker updates automatically shortly after launch; explicit
// registration here also gives us a handle for manual update checks.
registerSW({ immediate: true })

/**
 * Ask the browser to re-check the service worker right now. When a newer
 * version exists it activates and reloads the page on its own (autoUpdate),
 * so resolving quietly means we're already current. No-op in dev, where no
 * service worker is registered.
 */
export async function checkForUpdates() {
  const registration = await navigator.serviceWorker?.getRegistration()
  await registration?.update()
}
