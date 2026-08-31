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

## Calibration

Three constants in `altitude.js` are the whole tuning surface:
`window = 5` (smoothing), `threshold = 10` (metres before a climb counts),
`accFactor = 1.5` (movement gate). Tune against a real ride recorded alongside
Strava.

## Not done yet

Barometer (unreachable from a browser on both platforms — needs a native shell
wrapping this same `altitude.js`), watch support, backend.
