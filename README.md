# Meguri 巡り

Round-trip walking and cycling routes of exactly the length you want, starting
anywhere you like.

Most route planners want a destination. Meguri doesn't: you give it a starting
point and a distance — or how long you feel like being out — and it plots a
loop that brings you back where you began. Then it can navigate you around it,
turn by turn.

*Meguri* (巡り) is Japanese for "a circuit, a going-around".

Available in English, Dutch and Japanese. Installable as a PWA.

## Features

- **Loops, not routes.** Pick a start by searching, tapping the map, or using
  your location. Choose a distance in km or a duration, and get a round trip.
- **Quiet by default.** Bike paths and footpaths are preferred, busy roads
  avoided and traffic lights penalised.
- **Prefer nature over city.** A toggle that pushes routes through parks,
  woods and along water instead of straight through town.
- **No backtracking.** Loops are scored on how much they double back on
  themselves; a slightly shorter loop beats one that retraces its own steps.
- **Turn-by-turn navigation** with a follow camera, spoken guidance in all
  three languages, progress and arrival time, and a screen-wake lock. On foot
  the arrow and the map follow the compass, because course over ground is
  meaningless at walking pace; on a bike they follow the road ahead.
- **Wrong turn?** It routes you back to the loop rather than rewriting it — a
  round trip of a chosen length only stays that if it survives intact.
- **Demo mode.** A button beside Start hands navigation a receiver that walks
  the loop by itself — scattered fixes, drifting pace, and a wrong turn on
  request — so the whole thing can be shown without going outside. It says on
  screen that the position is invented, and a demo is never resumed as a real
  session.
- **GPX export** with elevation, for a watch or bike computer.
- **Remembers your session** — settings, the last loop, and navigation itself
  survive a refresh.

## How it works

There is no backend. Everything runs in the browser.

To build a loop, the app places waypoints on a circle around your start,
routes through them, and rescales the circle until the routed length matches
your target. Candidates are scored on both length accuracy and street overlap,
and out-and-back spurs are trimmed away. If a waypoint lands somewhere
unroutable — water, private land — the circle swings to new terrain instead of
giving up.

Routing uses [BRouter](https://brouter.de). Two profiles live in
`src/profiles/`, derived from its stock `trekking` and `hiking-beta`: they
enable BRouter's forest, town, noise and traffic estimates, add turn
instructions to the walking profile (the stock one emits none), and put a
heavy penalty on loose surfaces for the bike, so the nature preference can't
route it across a beach. The walking profile only avoids mud — sand is what a
walk in the dunes is made of. They are registered with BRouter at runtime and
cached; bump `PROFILE_VERSION` in `src/infra/brouter.ts` when a `.brf` changes.

| Service | Used for |
| --- | --- |
| [BRouter](https://brouter.de) | routing and turn instructions |
| [OpenFreeMap](https://openfreemap.org) | vector map tiles |
| [Nominatim](https://nominatim.org) | place search and reverse geocoding |

All free and keyless, all built on [OpenStreetMap](https://www.openstreetmap.org)
data. **Please note their usage policies.** They are shared community
infrastructure sized for modest use — if you fork this and put real traffic
through it, self-host BRouter and Nominatim, or move to a commercial plan.

## Stack

Vue 3 with TypeScript, Vite, MapLibre GL JS, `vite-plugin-pwa`, and a small
hand-rolled i18n layer in `src/i18n.ts`. No UI framework, no state library.

The code is layered with the dependency rule pointing inward:

- `src/domain` — pure logic: geodesy, loop generation (the router is injected
  as a function), route-following mathematics. No Vue, no i18n, no network,
  no browser APIs — everything here is trivially testable.
- `src/infra` — adapters for the outside world: the BRouter client, Nominatim,
  speech synthesis, GPX download.
- `src/app` — orchestration: the planner store, the navigation session, and
  the guidance policy (what to announce, when, in which words). Position
  policy lives here too: where we believe you are between fixes, and how much
  to trust dead reckoning, are decisions rather than drawing.
- `src/map` — MapLibre adapters, one per concern: the basemap tweaks, the
  route layers, the markers, the arrow, and the follow camera. Each is a
  factory closing over the map and its own state, so nothing shares a scope
  with anything it doesn't need.
- `src/composables` — reusable Vue state: the bottom sheet's drag and snap,
  the debounced place search.
- `src/components` — the Vue UI on top, wiring the above together.

## Development

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # production build + service worker into dist/
pnpm preview    # serve the production build
pnpm typecheck  # vue-tsc over src and tests
```

Regenerate the PNG icons after editing `public/favicon.svg`:

```sh
node scripts/make-icons.mjs
```

### Tests

```sh
pnpm test
```

Vitest, no browser. The suite pins down the navigation logic that is awkward
to check by riding around: locating yourself on a loop whose finish sits on
its start, rejecting GPS jumps without freezing progress, dropping the pace
to zero when you stop, needing several fixes off the line before calling a
wrong turn, taking the direction of the road rather than an average across a
corner, and re-indexing turn instructions when spurs are trimmed. The demo's
simulated receiver is pinned down too: that it scatters, drifts, strays far
enough to be called a wrong turn, and covers the same ground between fixes
however fast it is told to run. Most of these exist because that exact case
went wrong on a real ride.

### Deployment

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. A project site is served from `/<repo>/`, so
the build reads `BASE_PATH` and threads it through the bundle, the PWA
manifest and the service worker scope. Any other static host works too — build
with the default `/` base and serve `dist/`.

## Licence

Not yet chosen. Without one, default copyright applies and others may not
reuse the code — add a `LICENSE` file if you want that to change.
