import { ref } from 'vue'

/**
 * The device compass.
 *
 * GPS gives course over ground, which needs you to be moving and jitters
 * wildly when you aren't — fine on a bike, useless at walking pace. On foot
 * the arrow should point where the phone points, which is what this reads.
 *
 * Deciding when to use it is guidance policy and lives in app/nav-session.
 */

export type CompassStatus =
  | 'off' // not asked for yet
  | 'unsupported' // no such API, or not a secure context
  | 'denied' // the sensor was refused
  | 'silent' // permitted, but nothing has arrived
  | 'live' // readings coming in

/**
 * Reported rather than swallowed. Every way this can fail looks identical
 * from the saddle — the arrow simply doesn't turn — so the UI needs to be
 * able to say which one happened and offer another go.
 */
export const compassStatus = ref<CompassStatus>('off')

// Not reactive: the follow loop reads it every frame, and waking Vue sixty
// times a second to say "the phone moved a degree" helps nobody.
let heading: number | null = null
let listening = false

/** Degrees clockwise from true north, or null if we have no reading. */
export function compassHeading(): number | null {
  return heading
}

type CompassEvent = DeviceOrientationEvent & { webkitCompassHeading?: number }

function onOrientation(event: Event) {
  const e = event as CompassEvent
  // iOS hands over a true-north bearing directly. Everywhere else `alpha` on
  // an absolute event counts anticlockwise from north, so it has to be
  // flipped before it means the same thing.
  if (typeof e.webkitCompassHeading === 'number' && !Number.isNaN(e.webkitCompassHeading)) {
    heading = e.webkitCompassHeading
  } else if (e.absolute && typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
    heading = (360 - e.alpha) % 360
  } else {
    return // an event, but not one that knows where north is
  }
  compassStatus.value = 'live'
}

/**
 * Ask for the compass.
 *
 * iOS only grants this from inside a user gesture and only over HTTPS, so it
 * has to come straight from a tap — the same door speech goes through. The
 * answer is remembered per origin: once refused, iOS will not prompt again,
 * which is why the UI offers a visible retry rather than trying quietly.
 */
export async function startCompass(): Promise<CompassStatus> {
  if (listening) return compassStatus.value

  const ctor = (window as unknown as { DeviceOrientationEvent?: unknown })
    .DeviceOrientationEvent as
    | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> })
    | undefined

  // No API at all, or a plain-HTTP origin where iOS hides it. Testing over
  // http://<lan-ip> lands here, which looks exactly like a broken compass.
  if (!ctor || !window.isSecureContext) {
    compassStatus.value = 'unsupported'
    return compassStatus.value
  }

  try {
    if (typeof ctor.requestPermission === 'function') {
      if ((await ctor.requestPermission()) !== 'granted') {
        compassStatus.value = 'denied'
        return compassStatus.value
      }
    }
  } catch {
    // Thrown when not called from a gesture — a resumed session, typically.
    compassStatus.value = 'denied'
    return compassStatus.value
  }

  // Android fires the absolute variant; iOS only the plain one, carrying
  // webkitCompassHeading. Listening to both and letting the handler sort it
  // out is cheaper than sniffing the platform.
  window.addEventListener('deviceorientationabsolute', onOrientation)
  window.addEventListener('deviceorientation', onOrientation)
  listening = true
  // Granted, but nothing has arrived yet. If it stays here, the sensor is
  // permitted and mute — an uncalibrated magnetometer, or a device without
  // one — which is a different problem from being refused.
  compassStatus.value = 'silent'
  return compassStatus.value
}

export function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrientation)
  window.removeEventListener('deviceorientation', onOrientation)
  listening = false
  heading = null
  compassStatus.value = 'off'
}
