# elevationtrack

Phone-based elevation-gain tracker. Records how much you climbed, independently
of Strava, on any smartphone — no app install, no API key, no account.

## Run it

    ./serve.sh

Prints an `https://….trycloudflare.com` URL. Open it on the phone, allow
location, press Start. HTTPS is required — browsers refuse geolocation otherwise.

    node test.mjs      # the validation suite

## How it works

Elevation does **not** come from the phone's altimeter. Each GPS fix's lat/lon is
looked up in a terrain model (AWS Terrarium tiles, SRTM-derived, no API key),
bilinearly sampled, smoothed, then accumulated with a threshold.

This is Strava's own method for activities recorded without a barometer, and it
buys two things:

- **Cross-platform.** Android Chrome returns `null` for GPS altitude, so any
  altitude-based tracker simply does not work there.
- **Saw-toothing is structurally impossible.** The same coordinate always returns
  the same elevation, so GPS noise cannot manufacture metres that were never
  climbed — the fraud that currently needs a human reviewer.

Every fix passes a gate before reaching the math: cold-start settling, a movement
gate at `1.5 × GPS accuracy`, and a teleport gate at 30 m/s. Without these,
standing still on a slope fabricates ~170 m over 50 minutes; with them, ~11 m.

## Accuracy

Measured on a synthetic 10-lap hill: **932 m against a true 1000 m.** The bias is
deliberate — the setting that scored −2.8% let phantom gain reach 39 m/50 min.
Overcounting is an integrity failure; undercounting is systematic and calibrates
out. `test.mjs` enforces that asymmetry: never above truth, never >10% below.

## Files

| | |
|---|---|
| `altitude.js` | All the math. Pure — no DOM, no network. |
| `index.html`  | The tracker UI. |
| `test.mjs`    | Validation suite. |
| `serve.sh`    | Local server + HTTPS tunnel. |
| `compare.mjs` | Re-derives a track's gain from 4 terrain datasets and 3 algorithms. |

## Validating it — what to compare against

**There is no single true elevation-gain number.** Strava, Garmin and Google all
disagree, because each derives elevation from a different terrain dataset. Run
`compare.mjs` on any track and the disagreement is visible:

    node compare.mjs track.json [--truth 350]

The same 150-point ascent, same algorithm, four independent terrain datasets:

| terrain source | gain |
|---|---|
| mapzen (this app) | 1275 m |
| srtm30m | 1275 m |
| eudem25m | 1230 m |
| swisstopo LiDAR 0.5 m | 1311 m |

**6.5% spread from the data alone.** No algorithm can be more consistent than
the terrain data underneath it, so "matches Strava exactly" is not a
reachable target — and not the right one.

### The one reference that is not an estimate

Pick a route that is **one continuous climb** — no rolling, no descent — and take
the surveyed elevation of its start and end points. The difference is the true
gain, and no smoothing or threshold choice can influence it. Then:

1. Walk it once, recording with this app.
2. `node compare.mjs track.json --truth <surveyed delta>`

Sources of surveyed elevation: swisstopo `map.geo.admin.ch` (Switzerland,
0.5 m LiDAR), national mapping agencies elsewhere, or trig-point markers.
In Switzerland `compare.mjs` prints the surveyed endpoint difference for you.

Then repeat the same climb 5 times in one recording. True gain is 5x the delta.
That is the test that matters, because it exercises the accumulator the way an
Everesting does.

## Calibration

Three constants in `altitude.js` are the whole tuning surface:
`window = 5` (smoothing), `threshold = 10` (metres before a climb counts),
`accFactor = 1.5` (movement gate). Tune against a real ride recorded alongside
Strava.

## Not done yet

Barometer (unreachable from a browser on both platforms — needs a native shell
wrapping this same `altitude.js`), watch support, backend.
