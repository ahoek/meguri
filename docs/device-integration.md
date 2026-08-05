# Reaching the device

Meguri is a web app that wants to behave like a navigation device: know where
you are, which way you're facing, keep talking with the screen dark, and hand
the finished loop to whatever you ride or wear. This is a survey of what the
platform will and won't give it, written 2026-08-04 so the closed doors don't
get proposed again.

Each entry says what it buys, roughly what it costs, and — the part that
usually decides it — whether it works on an iPhone. Nothing here is committed
to; it's a map of the territory.

A theme worth noticing before the list: three separate questions in this
survey (Apple Watch, Bosch head unit, other route apps) all end at the same
answer, which is **a GPX file handed to the system share sheet**. The file is
the integration. That was the highest-leverage thing on this page by a
distance, and it is now built — `navigator.share({ files })` guarded by
`canShare`, with the anchor kept as the floor for browsers without a sheet.
A dismissed sheet counts as a no, so nothing is dropped into Downloads as a
consolation prize.

## Already in

Listed so it's clear what's spent and what's left.

| Capability | Where |
| --- | --- |
| `geolocation.watchPosition`, with a watchdog for silent stalls | [`app/nav-session.ts`](../src/app/nav-session.ts) |
| `geolocation.getCurrentPosition` for "use my location" | [`app/store.ts`](../src/app/store.ts) |
| `DeviceOrientationEvent` compass, incl. the iOS gesture-and-permission door | [`infra/compass.ts`](../src/infra/compass.ts) |
| `speechSynthesis`, incl. the iOS priming utterance and voice inventory | [`infra/speech.ts`](../src/infra/speech.ts) |
| Screen Wake Lock, re-acquired on visibility change | [`app/nav-session.ts`](../src/app/nav-session.ts) |
| Service worker, install, offline tile cache (600 tiles, 30 days) | [`infra/pwa.ts`](../src/infra/pwa.ts), [`vite.config.ts`](../vite.config.ts) |
| `display-mode: standalone` detection, to give honest permission advice | [`components/NavPanel.vue`](../src/components/NavPanel.vue) |
| Portrait lock, via the manifest rather than the unsupported JS API | [`vite.config.ts`](../vite.config.ts) |
| GPX to the system share sheet, falling back to a download | [`infra/gpx.ts`](../src/infra/gpx.ts) |

See also the permissions research in the session memory: iOS caches a refused
compass per origin and offers no way to query it without prompting, which is
why `off` and `denied` share a branch.

## Worth doing, works on an iPhone

**`navigator.storage.persist()` and `estimate()`.** The tile cache is what a
walk with no signal rests on, and it's also the first thing an eviction takes.
`persist()` asks the browser not to; `estimate()` lets the planner footer say
how many MB of map are held, turning invisible offline readiness into
something checkable — the same argument as showing `__BUILD__`.

**Media Session with a silent looping audio element.** Registers the app as
media playback: lock-screen and AirPods controls to mute guidance, and speech
survives being pushed to the background by a notification. Be clear about the
limit — no browser gives a web app position fixes with the screen locked, so
this does **not** buy pocket navigation and the wake lock stays load-bearing.
It buys not losing your voice when something else grabs the foreground.

**Permissions API for geolocation.** `navigator.permissions.query({ name:
'geolocation' })`, feature-detected, Safari's coverage partial. Earns the same
thing `compassStatus` already earns: telling "blocked, and no prompt is
coming" apart from "still getting a fix", instead of both looking like a
spinner.

**`DeviceMotionEvent` for step cadence.** The one genuinely new sensor, and
the hard part is already paid for — iOS gates it behind the same
`requestPermission` gesture flow that [`infra/compass.ts`](../src/infra/compass.ts)
implements. Accelerometer step detection is strongest exactly where GPS is
weakest (walking pace, stopped-versus-moving), which is the judgement
`nav-session` currently makes from fixes alone. Most work of anything in this
section, and the most likely to improve a real walk.

**`visualViewport`.** Not a sensor, but the same family of mobile fix: keep
the iOS keyboard off the place-search results in
[`composables/useBottomSheet.ts`](../src/composables/useBottomSheet.ts).

## Android and Chromium only

Cheap, and no-ops on iOS. Not worth a trip on their own; worth folding in if
something else is already open.

- **`navigator.vibrate`** — a buzz at each turn, so guidance works with the
  phone silent. No iOS support in any version, so it supplements speech and
  can never replace it.
- **Manifest `shortcuts`** — long-press the icon for "5 km walk" or the last
  loop. Ignored by iOS.
- **Manifest `share_target`** — receive a GPX someone shared to you.
- **Manifest `file_handlers`** — open a `.gpx` with Meguri. Chromium desktop.
- **Network Information and Battery Status** — back off fix rate and tile
  prefetch on a dying phone.

For GPX *import*, skip `share_target` and use `<input type="file"
accept=".gpx,application/gpx+xml">`. It works everywhere, iOS included.

## The wrist: HealthKit and Apple Watch

Both closed, for different reasons. **HealthKit** has no web API at all —
nothing to feature-detect, native-only. **Apple Watch** can't run a PWA
because watchOS has no browser and no way to install web apps, and there's no
WatchConnectivity from a page.

What remains:

- **GPX to a watch app.** WorkOutDoors and similar import a GPX route,
  navigate it on the wrist, and record the workout natively — so HealthKit
  gets written by the app entitled to write it. Meguri's job ends at the file.
  This is the real answer and it's the Web Share item again.
- **Shortcuts as a one-way bridge into Health.** A page can open
  `shortcuts://run-shortcut?name=…&input=…`, and a Shortcut can log a Health
  sample; a "Log to Health" button after a finished loop could hand over
  distance and duration. No native code needed. The catches: the Shortcut is
  installed by hand once per device, the URL scheme yanks you out of the app,
  and getting a result back is awkward. Fair for one rider on one phone,
  not a shippable feature.
- **Media Session metadata reaches the wrist.** Do the silent-audio work and
  Now Playing mirrors to the watch, so the current instruction could appear
  there as a track title. Genuinely fun, genuinely fragile, and an abuse of
  the field. Curiosity, not roadmap.

None of it gives data *in* — heart rate, steps, workout state. That needs a
native shell: Swift around a WKWebView with a HealthKit entitlement, a
watchOS companion target to record a workout properly, and the Developer
Programme. It also costs the deploy loop (push to `main`, it's on the phone)
and replaces it with archive, sign, TestFlight.

## The e-bike

Prompted by Bosch's Flow app, which reads the bike live. Findings
2026-08-04.

**Direct BLE is out.** Web Bluetooth is absent from Safari on iOS and iPadOS
in every version, with no sign Apple intends to add it, so a PWA on an iPhone
cannot see the bike at all. Third-party BLE browsers (Bluefy) exist but mean
browsing Meguri inside someone else's app instead of the installed PWA. On
Android Chrome the API exists, but the Bosch Smart System's BLE is
proprietary and authenticated — the Home Assistant community needs a separate
ESPHome Bluetooth bridge for live values, which marks that path as a
reverse-engineering project rather than an integration.

**Flow can do it because it's native and Bosch's own.** Their Connected
Biking platform — eBike SDK plus Cloud APIs, exposing speed, battery, rider
power, cadence — is B2B: manufacturers, fleets, leasing, insurers. Contract-
gated, not self-serve.

**The one open door: the EU Data Act API.** Bosch runs a portal where an
individual owner registers their own OAuth client against their SingleKey ID
and pulls their own bike's data; EU-registered accounts only. It yields
distance, speed, cadence, elevation, calories, GPS tracks, odometer, battery
health, motor hours, service schedules — and there's a working Home Assistant
integration to read as reference. Two things make it a poor fit here: it's
OAuth against a cloud API, so it needs a client secret and a CORS-permitting
server, and Meguri has no backend on purpose; and it's polled post-ride
(order of half an hour), so it can describe a ride but can't inform one being
planned. A history feature, not a routing one.

**What works today: GPX into Flow.** Flow imports GPX directly — Ride › My
routes › ⋯ › Import GPX file — and syncs Komoot routes automatically, so a
Meguri loop reaches a Kiox or Nyon for navigation. On the older eBike Connect
system the GPX goes via that portal or app instead, and non-routable tracks
lose distance-to-destination on the display.

**What the connection was probably wanted for: range.** If the goal is "a
loop I can finish on this charge", the bike isn't needed — a battery model is:
capacity, assist level, rider weight, and the elevation profile BRouter
already returns and the GPX already carries. That becomes a third constraint
beside distance and duration, works on an iPhone, with any drive system,
nothing paired. Less accurate than a real state of charge, and blind to being
left in Turbo, but buildable without waiting on Apple or Bosch.

## Closed doors

Don't re-propose without new platform news.

- **Background geolocation.** No browser delivers fixes with the screen
  locked. The wake lock is the answer, not a workaround for a missing one.
- **Web Push.** iOS supports it for installed PWAs, but sending needs a
  server Meguri doesn't have, and turn instructions aren't notifications.
- **Fullscreen API** — not available for arbitrary elements on iPhone.
- **`screen.orientation.lock()`** — unsupported in iOS Safari; the manifest
  already pins portrait.
- **Generic Sensor API** (`AbsoluteOrientationSensor` and friends) —
  Android-only, and a duplicate of what `compass.ts` already gets.
- **Web NFC, Web Bluetooth, Contact Picker, Badging** — no fit, or no iOS.

## Sources

- [Web Bluetooth browser support](https://caniuse.com/web-bluetooth)
- [Importing routes into the eBike Flow app](https://help.bosch-ebike.com/us/help-center/ebw-flowapp-navigation/asset-ast-00019)
- [Can I navigate GPX routes with Kiox?](https://help.bosch-ebike.com/us/help-center/asset-asf-00110)
- [Bosch Connected Biking: Cloud API and eBike SDK](https://www.bosch-ebike.com/us/company/industry-solutions/cloud-api-ebike-sdk)
- [Bosch eBike Live Data Interface](https://www.bosch-ebike.com/us/business/live-data-interface)
- [ha-bosch-ebike — Data Act API integration](https://github.com/Xunil99/ha-bosch-ebike)
