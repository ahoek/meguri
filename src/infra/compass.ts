/**
 * The device compass.
 *
 * GPS gives course over ground, which needs you to be moving and jitters
 * wildly when you aren't — fine on a bike, useless at walking pace. On foot
 * the arrow should point where the phone points, which is what this reads.
 *
 * Deciding when to use it is guidance policy and lives in app/nav-session.
 */

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
    return
  }
  if (e.absolute && typeof e.alpha === 'number' && !Number.isNaN(e.alpha)) {
    heading = (360 - e.alpha) % 360
  }
}

/**
 * Ask for the compass. iOS only grants this from inside a user gesture, so
 * call it straight from the tap that starts navigation — the same door
 * speech has to go through.
 */
export async function startCompass(): Promise<boolean> {
  if (listening) return true
  const ctor = (window as unknown as { DeviceOrientationEvent?: unknown })
    .DeviceOrientationEvent as
    | (typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> })
    | undefined
  if (!ctor) return false

  try {
    if (typeof ctor.requestPermission === 'function') {
      if ((await ctor.requestPermission()) !== 'granted') return false
    }
  } catch {
    return false // denied, or not called from a gesture
  }

  // Android fires the absolute variant; iOS only the plain one, carrying
  // webkitCompassHeading. Listening to both and letting the handler sort it
  // out is cheaper than sniffing the platform.
  window.addEventListener('deviceorientationabsolute', onOrientation)
  window.addEventListener('deviceorientation', onOrientation)
  listening = true
  return true
}

export function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrientation)
  window.removeEventListener('deviceorientation', onOrientation)
  listening = false
  heading = null
}
