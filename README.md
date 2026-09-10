<h1 align="center">
  <img src="icon-192.png" width="72" height="72" alt=""><br>
  Altitrack
</h1>

<p align="center">
  Elevation-gain tracker that runs in the browser of any phone, anywhere in the
  world. Records how much you climbed — on roads, on trails, and up stairs —
  with no app install, no API key and no account.
</p>

<p align="center">
  <b><a href="https://hazel080.github.io/elevationtrack/">▲ &nbsp;Open the tracker</a></b>
</p>

<p align="center">
  <sub>every country · iOS + Android · nothing leaves the phone</sub>
</p>

---

## Try it

**[hazel080.github.io/elevationtrack](https://hazel080.github.io/elevationtrack/)**

That link is the whole product. There is nothing to install, no account, no key,
and nothing to configure — open it on a phone, allow location, press **Start**.
Send the link to anyone and they have the same tool.

Indoors, at a desk, with no GPS? Press **Demo track** and the display fills with a
recorded climb run through the real accumulator, so the numbers and both exports
can be inspected without going outside.

**Keep it on the home screen** and it opens full-screen with its own icon, like
any other app:

| iPhone | Android |
|---|---|
| Safari → **Share** → *Add to Home Screen* | Chrome → **⋮** → *Add to Home Screen* / *Install app* |

**While recording,** leave the screen on — the app holds a wake lock — and keep
the tab in front. Backgrounded browsers get their GPS throttled or suspended by
both operating systems; that is a platform limit, not a setting.

**Exports.** *Send recording…* opens the phone's own share sheet with both
files attached — Mail, AirDrop, WhatsApp, Files, whatever the tester already
uses. *Save GPX* gives a file Strava, Garmin Connect and Komoot import directly;
*Save JSON* gives the full session record (below).

## Testing it in the field

The point of a test walk is a file that someone else can check. Fill in the
**route name** and, if you know it, the **surveyed gain**, walk the route, then
press **Send recording…** and mail it to whoever is collecting them. The file
names itself after the route and the date, because a mailbox of twelve
`altitrack.json` files is not a dataset.

### What the recording contains

The JSON is a complete session record — the evidence, not just the answer:

| | |
|---|---|
| `label`, `surveyed_gain` | what was walked, and what it truly climbs, so the file scores itself |
| `total_elevation_gain` | terrain + stairs, and each half separately |
| `track` | every accepted point with the height the terrain model returned, plus `hi`/`lo` from the between-fix scan |
| `gps_fixes` | **every fix the receiver produced**, accepted or not, each with the reason the gate gave it |
| `device` | the browser and phone, because the GPS chip is half the answer |
| `streams` | Strava-activity-shaped, so it drops into an existing pipeline |

`gps_fixes` is the one that earns its place. A summary can only be believed or
disbelieved; the raw receiver trace lets a number that looks wrong be
re-derived, and the gate constants re-tuned, without anyone walking the route
again.

### Scoring the files that come back

    node compare.mjs recording.json

Re-derives the climb from several independent terrain datasets and algorithms.
It reads `surveyed_gain` out of the file, so no flag is needed, and it prints
the tally of gate verdicts — a walk that was 80% `stationary` rejections tells
you more than the gain figure does.

### Comparing against Apple Health

    node health.mjs recording.json export.zip

Every iPhone since the 6 has a barometer, and HealthKit's flights-climbed comes
from it, fused with the accelerometer so lifts and escalators are filtered out.
**A browser cannot reach that sensor** — no platform exposes pressure to a web
page — which is exactly what makes it an independent reference, and the only one
that exists for stairs, where terrain models have nothing to say at all.

The tester exports it themselves: *Health app → profile picture → Export All
Health Data* → `export.zip`. Point `health.mjs` at it and the recording's own
time window is scored against the barometer:

    altitrack terrain       156.3 m
    altitrack stairs          7.1 m   (42 steps x 0.17 m)
    Apple Health flights        7  = 21.0 m   (Luca's iPhone)
    Apple Health workout    162.0 m   (Fitness, iPhone)
      terrain vs workout     -3.5%
      stairs  vs flights    -66.2%

Read it as a reference, never as truth: **any app can write anything into
HealthKit**, so `health.mjs` prints the source of every number; a "flight" is a
flat 3 m by convention rather than a measurement of the staircase you climbed;
and a barometer drifts with the weather over a long day.

**Why this is a file and not a login.** HealthKit and Health Connect are
native-only — device-side APIs behind an app entitlement, with no OAuth, no
webhook and no web API of any kind. A page in a browser cannot read either one,
and no third-party aggregator changes that; they all hand you an SDK to embed
under the same on-device constraint. Live Health sync needs the native shell
that would also unlock the barometer, which is the same item already sitting in
[Not done yet](#not-done-yet).

*Android:* Health Connect has the same shape (`FloorsClimbedRecord`,
`ElevationGainedRecord`) but no stable file export to point a script at — and
most Android handsets have no barometer at all, so its floor count is usually
derived from the same accelerometer this app already reads. Compare on iOS.

## Where it works

**Everywhere on Earth.** Elevation comes from a global terrain model — AWS
Terrarium, ~30 m, covering every land surface between 85°N and 85°S — reached
over plain HTTPS with no key and no quota. There is no country list, no
region setting and no place the app has to be told about.

On top of that, where a national survey publishes something better, the app
uses it:

| where | dataset | resolution |
|---|---|---|
| **everywhere** | AWS Terrarium (SRTM/GMTED) | ~30 m |
| Spain | IGN MDT (PNOA LiDAR) | 5 m |
| Switzerland | swisstopo swissALTI3D | 0.5 m |

Those two are a bonus on top of the worldwide path, not a requirement for it —
nothing degrades outside them beyond the resolution of the global model, and
adding a third is a bounding box and a fetch in `altitude.js`.

The national choices are bounding boxes, and every bounding box overhangs its
border: the Spanish one reaches Portugal, Andorra and Perpignan, the Swiss one
reaches Como, Chamonix and Bregenz. So the choice is *probed* against the real
service on the first fix and falls back to the global model wherever the
national one has no coverage. Only a coverage answer falls back — a slow
request must not quietly downgrade a whole ride.

## Stairs

A staircase is invisible to everything above. A terrain model returns one ground
height for an entire stairwell, a flight's horizontal movement is smaller than
the GPS movement gate, and **no browser on either platform exposes a barometer**
— iOS and Android both refuse the pressure sensor to web pages. So stairs are
counted footfall by footfall from the accelerometer.

Press **Stairs** at the bottom of the flight, press it again at the top. Every
step counted books **0.17 m**, and the total joins the climb on the main display.

Two deliberate choices:

- **The height is not measured, it is known.** Estimating a single step's rise by
  integrating acceleration is published at roughly ±30% error. A stair riser, on
  the other hand, is legislated into a narrow band nearly everywhere — 17-18 cm
  across most of the EU, 7 in (17.8 cm) under the US IBC, 18 cm in the UK — so
  counting steps and multiplying is the far more accurate of the two.
- **The direction is yours to state, not the app's to guess.** Telling stairs
  from a flat corridor, and up from down, is 85-90% accurate at best from
  acceleration alone. A wrong metre is the one failure this project exists to
  avoid, so the app never guesses: it counts only while you have said you are
  climbing.

A step also only counts when it follows another step at a walking cadence, so an
isolated jolt — the phone slapping a leg, coming out of a pocket, a pothole —
books nothing, and shaking the phone books nothing. The cost is the first step of
each flight, about 17 cm, which is the right direction to be wrong in.

## Which phones and browsers

Any phone with a GPS and a browser from roughly 2021 onward. It is one HTML file
and one ES-module — no framework, no build step, no bundle.

- **iOS** Safari, Chrome, Firefox, Edge (all iOS browsers are Safari underneath).
  Stairs needs *Settings → Safari → Motion & Orientation Access* on, and the app
  asks for it when you press Stairs.
- **Android** Chrome, Firefox, Samsung Internet, Edge.
- **Desktop** works too, for reading a track and exporting it.

Nothing depends on a recent browser: `OffscreenCanvas`, `createImageBitmap` and
`AbortSignal.timeout` all have fallbacks, because they landed in Safari only in
16.4 / 15 / 15.4 and a lot of phones in use are older than that. `localStorage`
failing outright — as it does in some private-browsing modes — degrades to a
track that records normally but is not saved across a reload.

The one hard requirement is **HTTPS**: browsers refuse geolocation on plain
`http://`. The published copy is served over HTTPS, so this only matters if you
host it yourself.

## Privacy

There is no backend and no account. The track lives in the phone's
`localStorage` and nowhere else. The only outbound requests are terrain
lookups — a coordinate goes out, a height comes back. Nothing is uploaded, and
the exports are files the phone hands you.

Sending a recording is therefore a deliberate act, and worth knowing what it
contains: the full route, every raw GPS fix, and the browser's user-agent string
(which names the phone model). That is precisely what makes a test result
diagnosable, and it is location data about a person — treat a folder of them
accordingly, and collect them under the tester's consent rather than an
employer's. `health.mjs` runs entirely on your own machine; a Health export is
never uploaded anywhere by this project.

## How it works

Elevation does **not** come from the phone's altimeter. Each GPS fix's lat/lon is
looked up in a terrain model, smoothed, then accumulated with a threshold.

This is Strava's own method for activities recorded without a barometer, and it
buys two things:

- **Cross-platform.** Android Chrome returns `null` for GPS altitude, so any
  altitude-based tracker simply does not work there.
- **Saw-toothing is structurally impossible.** The same coordinate always returns
  the same elevation, so GPS noise cannot manufacture metres that were never
  climbed — the fraud that currently needs a human reviewer.

A track stays on **one** provider start to finish. Two datasets disagree by
metres at the same coordinate, so switching mid-ride would book that
disagreement as real climbing. If the provider fails mid-track, the fix is
skipped.

Every fix passes a gate before reaching the math: cold-start settling, a movement
gate at `1.5 × GPS accuracy`, a Doppler-speed gate (`coords.speed` reads ~0 while
standing still even as the position drifts), and a teleport gate at 30 m/s.
On top of the gates, **stationary episodes are removed from the math**: a run of
points that never leaves a 40 m circle for 2 minutes or more is someone resting
while the GPS wanders — nobody gains the 10 m threshold inside 40 m — and only
its last anchoring point survives. It is anchored to where the run started, not
a sliding window: at hike-a-bike pace a hairpin climb never leaves a sliding
40 m window either, and that variant erased the climb. And it is 2 minutes, not
10: drift leaves the circle and starts a new run long before 10 minutes, so a
long minimum collapses nothing.

Without all of this, standing still on a 30% slope for 50 minutes fabricates
~175 m; with it, 0 m in the synthetic test, and 0 on any phone that reports
Doppler speed regardless of terrain. The remaining exposure is a receiver that
drifts more than 40 m while reporting 20 m accuracy on a steep slope.

### Why the national models are worth the special case

The global model is a *surface* model: it measures rooftops and tree canopy, not
the ground you walk on. The error is largest in dense cities, which is exactly
where a lot of riding happens. Barcelona, as a worked example, against the 5 m
LiDAR terrain model of the same points:

| | LiDAR 5 m | global 30 m | surveyed |
|---|---|---|---|
| Tibidabo | 511.8 m | 512 m | ~512 |
| Montjuïc | 171.7 m | 180 m | ~173 |
| Plaça Catalunya | 21.1 m | 33 m | ~20 |

Open country is far kinder to the global model — the 7 m error at Plaça
Catalunya is a building, not terrain.

## Accuracy

After every accepted fix the terrain is also scanned along the line from the
previous fix (every 5 m on tiles, 10 m on the national services), because a
summit is usually *crossed* between two fixes rather than hit by one. The
extremes of that scan feed the accumulator.

Measured on a synthetic 10-lap out-and-back hill: **980 m against a true
1000 m**; on 10 km of 15 m rolling hills, **989 m against 1000 m**; on 30 m
hills with 20 m GPS accuracy, **2933 m against 3000 m** (2753 without the scan).
The out-and-back remainder is the turnaround itself: the last accepted fix is at
most one gate distance short of the top, and no straight-line scan between the
fix before and the fix after can see a point the path did not cross.

Smoothing is used only to decide *when* the track reverses; the amplitude of each
leg is read from the raw terrain value at that extremum. Reading it from the
smoothed series clipped every summit and valley (932 m on the hill test, 903 m on
rolling terrain) — a bias that grew with the number of extrema, so it could not
be calibrated out. Overcounting is an integrity failure, so `test.mjs` enforces
the asymmetry: never above truth, never more than 2.5% below on hills.

## Validating it — what to compare against

**There is no single true elevation-gain number.** Strava, Garmin and Google all
disagree, because each derives elevation from a different terrain dataset. Run
`compare.mjs` on any track and the disagreement is visible:

    node compare.mjs track.json [--truth 350]

The same 150-point ascent, same algorithm, three independent terrain datasets:

| terrain source | gain |
|---|---|
| mapzen / SRTM | 1275 m |
| eudem25m | 1230 m |
| national LiDAR 0.5 m | 1311 m |

**6.5% spread from the data alone.** No algorithm can be more consistent than
the terrain data underneath it, so "matches Strava exactly" is not a
reachable target — and not the right one.

### The one reference that is not an estimate

This works in any country, and needs nothing but a map:

1. Pick a route that is **one continuous climb** — no rolling, no descent — whose
   start and end points both have a *surveyed* elevation: a trig point, a
   benchmark, a spot height on the national topographic map, a station or summit
   sign. The difference between them is the true gain, and no smoothing or
   threshold choice can influence it.
2. Walk it once, recording with this app.
3. `node compare.mjs track.json --truth <surveyed delta>`

Then repeat the same climb five times in one recording. True gain is 5× the
delta. That is the test that matters, because it exercises the accumulator the
way an Everesting does.

`compare.mjs` prints the surveyed endpoint difference automatically where a
national height service exists (currently Spain and Switzerland). Everywhere
else, read the two numbers off your national mapping agency's map — every
country has one, and spot heights are exactly what they are for.

*A worked example, if you want one that is already measured:* Plaça Espanya →
Castell de Montjuïc, Barcelona. IGN surveys the endpoints at 26.6 m and
184.1 m — a **157.6 m** true climb, continuous, about 25 minutes on foot. On the
previous (smoothed-amplitude) accumulator this app read **155 m: 1.6% low**. Not
yet re-walked with the current one.

For stairs, the equivalent reference is trivial: count the steps in the flight by
hand, multiply by the measured riser, and compare.

## Files

| | |
|---|---|
| `altitude.js` | All the math — terrain accumulation, gating, step counting. Pure: no DOM, no network. |
| `index.html`  | The tracker UI. |
| `test.mjs`    | Validation suite. |
| `serve.sh`    | Local server + HTTPS tunnel. |
| `compare.mjs` | Re-derives a track's gain from several terrain datasets and 3 algorithms. |
| `health.mjs`  | Scores a recording against Apple Health's barometric flights and workout ascent. |
| `manifest.webmanifest`, `icon-*.png` | Home-screen install. No service worker: every fix needs a live terrain lookup, so an offline shell would only cache a screen that cannot record anything. |

## Calibration

Seven constants in `altitude.js` are the whole tuning surface:
`window = 5` (direction smoothing), `threshold = 10` (metres before a climb
counts), `accFactor = 1.5` (movement gate), `minSpeed = 0.3` m/s (Doppler gate),
`radius = 40` / `minTime = 120` (stationary episode), and `RISER = 0.17` (metres
per stair step — the one to change for an unusually steep or shallow staircase).
Tune against a real ride recorded alongside Strava.

## Develop it

    ./serve.sh        # local server + HTTPS tunnel, for testing an unpushed change
    node test.mjs     # the validation suite

`serve.sh` prints an `https://….trycloudflare.com` URL, which a phone can use
because it is HTTPS. Pushing to `main` republishes the public copy on GitHub
Pages.

## Not done yet

Barometer (unreachable from a browser on both platforms — needs a native shell
wrapping this same `altitude.js`), watch support, backend.
