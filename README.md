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
  three languages, progress and arrival time, and a screen-wake lock.
- **Wrong turn?** It routes you back to the loop rather than rewriting it — a
  round trip of a chosen length only stays that if it survives intact.
- **Nice spots along the way.** Viewpoints, public artwork, historic sites,
  mills and parks near the route, shown as pins and as a quiet card while you
  pass them.
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
heavy penalty on sand, mud and other loose surfaces so the nature preference
can't route a bike across a beach. They are registered with BRouter at runtime
and cached; bump `PROFILE_VERSION` in `src/lib/route.js` when a `.brf` changes.

| Service | Used for |
| --- | --- |
| [BRouter](https://brouter.de) | routing and turn instructions |
| [OpenFreeMap](https://openfreemap.org) | vector map tiles |
| [Nominatim](https://nominatim.org) | place search and reverse geocoding |
| [Overpass](https://overpass-api.de) | points of interest along the route |

All free and keyless, all built on [OpenStreetMap](https://www.openstreetmap.org)
data. **Please note their usage policies.** They are shared community
infrastructure sized for modest use — if you fork this and put real traffic
through it, self-host BRouter, Nominatim and Overpass, or move to a commercial
plan.

## Stack

Vue 3, Vite, MapLibre GL JS, `vite-plugin-pwa`, and a small hand-rolled i18n
layer in `src/i18n.js`. No UI framework, no state library.

## Development

```sh
npm install
npm run dev      # http://localhost:5173
npm run build    # production build + service worker into dist/
npm run preview  # serve the production build
```

Regenerate the PNG icons after editing `public/favicon.svg`:

```sh
node scripts/make-icons.mjs
```

### Deployment

Pushing to `main` builds and publishes to GitHub Pages via
`.github/workflows/deploy.yml`. A project site is served from `/<repo>/`, so
the build reads `BASE_PATH` and threads it through the bundle, the PWA
manifest and the service worker scope. Any other static host works too — build
with the default `/` base and serve `dist/`.

## Licence

Not yet chosen. Without one, default copyright applies and others may not
reuse the code — add a `LICENSE` file if you want that to change.
