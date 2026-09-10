// Pure elevation math. No DOM, no network — so node can test it.
// Mirrors Strava's non-barometric path: DEM lookup -> smooth -> threshold accumulate.

/** Terrarium PNG encoding: elevation = (R*256 + G + B/256) - 32768 */
export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

const TILE = 256;

/** Web-mercator global pixel coords at zoom z (fractional). */
export function toGlobalPixel(lat, lon, z) {
  const n = TILE * 2 ** z;
  const s = Math.sin((lat * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * n,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n,
  };
}

/** Bilinear sample. getPixel(px,py) -> elevation in metres. Avoids DEM staircase. */
export function sampleBilinear(getPixel, x, y) {
  const x0 = Math.floor(x - 0.5), y0 = Math.floor(y - 0.5);
  const fx = x - 0.5 - x0, fy = y - 0.5 - y0;
  const a = getPixel(x0, y0), b = getPixel(x0 + 1, y0);
  const c = getPixel(x0, y0 + 1), d = getPixel(x0 + 1, y0 + 1);
  return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
}

/** Centred moving average, window in samples. */
export function smooth(series, window = 5) {
  if (window < 2) return series.slice();
  const h = Math.floor(window / 2);
  return series.map((_, i) => {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - h); j <= Math.min(series.length - 1, i + h); j++) { sum += series[j]; n++; }
    return sum / n;
  });
}

/**
 * Peak-valley accumulator with hysteresis. Direction decisions come from a
 * centred moving average (window samples) so GPS jitter cannot reverse the
 * direction; the amplitude of each leg is read from the RAW series at the index
 * where the smoothed series peaked. Reading amplitude from the smoothed series
 * clipped every summit and valley by ~slope x spacing x window/4 — a bias that
 * grows with the number of extrema, so it could not be calibrated out on
 * rolling terrain (measured: 903 m of a true 1000 m; now 983).
 *
 * `hi`/`lo`: optional per-sample extremes of the terrain scanned along the
 * INTERIOR of the segment that arrives at that sample (see segmentSamples);
 * undefined where nothing was scanned. Endpoints are excluded so a fix's own
 * GPS noise enters only through its own value. A turnaround usually
 * falls between two fixes, so the summit is read from the two segments adjacent
 * to the smoothed extremum, not from the fix itself. Only the adjacent segments:
 * taking the max over the whole leg would select the noisiest fix.
 *
 * Wider window = less phantom gain but short bumps vanish (w=7 at 30 m spacing
 * lost ALL of a 30 m/200 m rolling profile). A median filter was tried and was
 * not better on either axis.
 */
export function gainLoss(elevations, threshold = 10, window = 5, { hi = [], lo = [] } = {}) {
  if (elevations.length === 0) return { gain: 0, loss: 0 };
  const s = smooth(elevations, window);
  const top = (i) => Math.max(elevations[i], hi[i] ?? -Infinity, hi[i + 1] ?? -Infinity);
  const bottom = (i) => Math.min(elevations[i], lo[i] ?? Infinity, lo[i + 1] ?? Infinity);
  let gain = 0, loss = 0, dir = 0;
  let anchor = elevations[0];          // raw elevation where the current leg started
  let ext = 0, iLo = 0, iHi = 0;        // indices into s (iLo/iHi: while direction unknown)

  for (let i = 0; i < s.length; i++) {
    const e = s[i];
    if (dir === 0) {
      if (e < s[iLo]) iLo = i;
      if (e > s[iHi]) iHi = i;
      if (e >= s[iLo] + threshold) { dir = 1; anchor = bottom(iLo); ext = i; }
      else if (e <= s[iHi] - threshold) { dir = -1; anchor = top(iHi); ext = i; }
    } else if (dir === 1) {
      if (e > s[ext]) ext = i;
      else if (e <= s[ext] - threshold) { const t = top(ext); gain += t - anchor; anchor = t; ext = i; dir = -1; }
    } else {
      if (e < s[ext]) ext = i;
      else if (e >= s[ext] + threshold) { const b = bottom(ext); loss += anchor - b; anchor = b; ext = i; dir = 1; }
    }
  }
  if (dir === 1) gain += Math.max(0, top(ext) - anchor);
  else if (dir === -1) loss += Math.max(0, anchor - bottom(ext));
  return { gain, loss };
}

/**
 * Gate on a raw GPS fix before it ever reaches the elevation math.
 * Returns true, or a string reason. This is where accuracy is won or lost:
 * a fix that is merely imprecise still produces a plausible-looking elevation,
 * so it has to be rejected here, not smoothed away later.
 */
export function shouldAccept(last, fix, { minMove = 10, accFactor = 1.5, maxAccuracy = 20, maxSpeed = 30, minSpeed = 0.3 } = {}) {
  if (!(fix.acc <= maxAccuracy)) return 'accuracy';
  if (!last) return true;
  // Doppler speed (coords.speed) reads ~0 while standing still even when the
  // position drifts tens of metres — the one signal that separates the two.
  // null / -1 = receiver did not report it; fall through to the distance gate.
  if (fix.speed != null && fix.speed >= 0 && fix.speed < minSpeed) return 'stationary';
  const d = haversine(last, fix);
  const dt = (fix.t - last.t) / 1000;
  // faster than any human on a hill => bad fix, not movement
  if (dt > 0 && d / dt > maxSpeed) return 'teleport';
  // moved less than the noise floor => we cannot tell movement from jitter
  if (d < Math.max(minMove, accFactor * fix.acc)) return 'stationary';
  return true;
}

/** True once the last `n` fixes agree within `radius` — i.e. GPS has settled. */
export function hasSettled(fixes, { n = 3, radius = 25 } = {}) {
  if (fixes.length < n) return false;
  const recent = fixes.slice(-n);
  return recent.every(a => recent.every(b => haversine(a, b) <= radius));
}

/**
 * Which terrain dataset to use for a coordinate. National LiDAR models are an
 * order of magnitude better than global SRTM, especially in cities, where SRTM
 * measures rooftops rather than ground.
 *
 * A track must stay on ONE provider start to finish. Two datasets disagree by
 * metres at the same point, so switching mid-track would book that disagreement
 * as real climbing.
 */
export function providerFor(lat, lon) {
  if (lat > 35.9 && lat < 43.9 && lon > -9.4 && lon < 4.4) return 'ign';        // Spain, MDT 5 m LiDAR
  if (lat > 45.8 && lat < 47.9 && lon > 5.9 && lon < 10.6) return 'swisstopo';  // Switzerland, 0.5 m LiDAR
  return 'terrarium';                                                           // global fallback, ~30 m
}

/**
 * The provider a track is locked to. Every national bounding box above is a
 * rectangle and every one of them overhangs its border — the Spain box covers
 * Portugal, Andorra and Perpignan; the Swiss box covers Como, Chamonix and
 * Bregenz. There the service answers "no coverage" for every fix, which would
 * leave the whole track empty. So the choice is probed once against the real
 * service and falls back to the global tiles when the answer is no coverage.
 * Only a coverage answer falls back: a timeout must not downgrade a whole ride
 * in Spain because one request was slow.
 */
export async function lockProvider(lat, lon, probe) {
  const want = providerFor(lat, lon);
  if (want === 'terrarium') return want;
  try { await probe(want, lat, lon); return want; }
  catch (e) { return e.message === 'no coverage' ? 'terrarium' : want; }
}

/**
 * Interior points every ~`step` metres along the straight line a -> b, so the
 * terrain between two fixes can be scanned for a summit that fell between them.
 * ponytail: straight line in lat/lon; fixes are 10-30 m apart so a hairpin cuts
 * at most a few metres of corner. Snap to a road network if that ever matters.
 */
export function segmentSamples(a, b, step) {
  const n = Math.floor(haversine(a, b) / step);
  return Array.from({ length: n }, (_, k) => {
    const f = (k + 1) / (n + 1);
    return { lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f };
  });
}

/**
 * Stationary episodes. A run of points that never leaves `radius` of where the
 * run started, lasting at least `minTime` seconds, is someone standing still
 * while the GPS wanders — nobody gains the 10 m threshold inside a 40 m circle.
 * The wander is dropped from the LATEST point that still anchors the run, so
 * the approach to the stop (and the true valley) is kept and only the wander goes.
 *
 * Why anchored to the run START and not a sliding window: at hike-a-bike pace a
 * zigzag climb (0.4 m/s, 30 m hairpins, 12% grade) never leaves a sliding 40 m
 * window either, and a sliding rule erased that climb entirely in testing.
 * Why 120 s and not 10 min: drift leaves the circle and starts a new run long
 * before 10 min, so a long minimum collapses nothing.
 * Measured: 50 min standing on a 30% slope with 20 m fixes, 37 m -> 18 m; with
 * 40 m of drift, 19 m -> 0. Real climbs unchanged.
 */
export function dropStationary(points, { radius = 40, minTime = 120 } = {}) {
  const within = (k, end) => points.slice(k + 1, end).every(p => haversine(points[k], p) <= radius);
  const out = [];
  for (let start = 0, i = 1; i <= points.length; i++) {
    if (i < points.length && haversine(points[start], points[i]) <= radius) continue;
    let k = start;   // latest anchor from which the rest of the run is still one stationary episode
    if ((points[i - 1].t - points[start].t) / 1000 >= minTime)
      for (let j = i - 1; j > start; j--) if ((points[i - 1].t - points[j].t) / 1000 >= minTime && within(j, i)) { k = j; break; }
    out.push(...points.slice(start, k + 1));
    if (k === start && (points[i - 1].t - points[start].t) / 1000 < minTime) out.push(...points.slice(start + 1, i));
    start = i;
  }
  return out;
}

/** WGS84 -> Swiss LV95 [E, N]. swisstopo's published approximation, ~1 m. */
export function wgs84ToLv95(lat, lon) {
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  return [
    2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p ** 2 - 44.54 * l ** 3,
    1200147.07 + 308807.95 * p + 3745.25 * l ** 2 + 76.63 * p ** 2 - 194.56 * l ** 2 * p + 119.79 * p ** 3,
  ];
}

/**
 * A stair riser, in metres. This is the one number in the app that does not
 * need measuring: risers are legislated almost everywhere and land in a narrow
 * band — 17-18 cm across most of the EU, 7 in (17.8 cm) in the US IBC, 18 cm
 * in the UK. So a counted stair step is worth 0.17 m to within a few percent
 * anywhere in the world, which is better than any accelerometer can estimate a
 * single step's height (published errors are ~30%).
 */
export const RISER = 0.17;

/**
 * Steps, from the accelerometer. No terrain model can see a staircase — a
 * stairwell is one lat/lon for twenty floors, and a flight's horizontal
 * movement is below the GPS movement gate — and no browser on either platform
 * exposes a barometer. Counting footfalls is what is left, and it is the part
 * of the problem that is genuinely reliable.
 *
 * Gravity is tracked as a slow EMA of the raw vector, so the phone can sit in
 * any pocket at any angle; the dynamic acceleration along that axis is what a
 * footfall shows up in. A peak above `peakAcc` books a step, with a refractory
 * gap so one footfall's ringing is not two.
 *
 * `maxStep` is the integrity gate: a step only counts when it follows another
 * step within a walking cadence. An isolated jolt — the phone slapping a leg,
 * being pulled out of a pocket, a car's pothole — books nothing, so the height
 * cannot be manufactured by shaking. The cost is the first step of every flight,
 * ~17 cm, which is the right direction to be wrong in.
 *
 * Direction is NOT inferred. Telling stairs from a flat corridor, and up from
 * down, is ~85-90% accurate at best from acceleration alone, and a wrong metre
 * is the one failure this app exists to avoid. The user says when they are
 * climbing; the app only counts.
 */
export function stairCounter({ riser = RISER, minStep = 0.28, maxStep = 1.6, peakAcc = 1.8, tau = 0.8 } = {}) {
  let g = null, tPrev = null, tPeak = null, tStep = null, above = false, steps = 0;
  return {
    get steps() { return steps; },
    get gain() { return steps * riser; },
    reset() { g = null; tPrev = tPeak = tStep = null; above = false; steps = 0; },
    /** t in SECONDS; x,y,z acceleration INCLUDING gravity, m/s^2. True when this sample booked a step. */
    push(t, x, y, z) {
      // A gap in the stream leaves the EMA stale and the cadence chain broken.
      if (tPrev == null || !(t > tPrev) || t - tPrev > 0.5) { g = [x, y, z]; tPrev = t; tStep = tPeak = null; return false; }
      const dt = t - tPrev; tPrev = t;
      const k = 1 - Math.exp(-dt / tau);
      g = [g[0] + k * (x - g[0]), g[1] + k * (y - g[1]), g[2] + k * (z - g[2])];
      const gm = Math.hypot(g[0], g[1], g[2]);
      if (!(gm > 1)) return false;                       // free fall or a dead sensor
      const a = (x * g[0] + y * g[1] + z * g[2]) / gm - gm;   // vertical, gravity removed, up positive
      if (a < peakAcc * 0.4) { above = false; return false; } // re-arm well below the threshold
      if (above || a < peakAcc) return false;
      above = true;
      // Refractory. It suppresses without touching the cadence chain, so one
      // footfall's ringing costs nothing — and a shake far faster than any
      // staircase keeps re-triggering it and never emits a step at all.
      const since = tPeak == null ? Infinity : t - tPeak;
      tPeak = t;
      if (since < minStep) return false;
      const gap = tStep == null ? null : t - tStep;
      tStep = t;
      if (gap == null || gap > maxStep) return false;    // start of a rhythm, or after a pause
      steps++;
      return true;
    },
  };
}

export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The file a tester sends back. One self-describing record of a walk: what was
 * walked, what the app decided, and the evidence for both.
 *
 * The evidence is the point. A summary alone can only be believed or
 * disbelieved; this carries every accepted point with the height the terrain
 * model returned for it, and every fix the receiver ever produced with the
 * verdict the gate gave it. So a number that looks wrong can be re-derived from
 * independent terrain data (compare.mjs), and the gate constants can be re-tuned
 * against the real receiver trace, without anyone walking the route again.
 *
 * `label` and `surveyed_gain` are what make a mailbox full of these useful:
 * a file that does not say what route it is, or what the route truly climbs,
 * cannot be scored against anything.
 */
export function sessionRecord({ points = [], fixes = [], steps = 0, provider = null, label = '', truth = null, device = '' } = {}) {
  const s = summarize(points);
  const stairs = +(steps * RISER).toFixed(1);
  return {
    format: 'altitrack/1',
    label: label || null,
    surveyed_gain: Number.isFinite(truth) ? truth : null,
    device: device || null,
    elevation_source: provider,

    total_elevation_gain: +(s.total_elevation_gain + stairs).toFixed(1),
    terrain_elevation_gain: s.total_elevation_gain,
    stairs: { steps, riser: RISER, gain: stairs },
    total_elevation_loss: s.total_elevation_loss,
    elev_high: s.elev_high, elev_low: s.elev_low,
    distance: s.distance,
    elapsed_time: s.elapsed_time, moving_time: s.elapsed_time,
    start_date: points[0] ? new Date(points[0].t).toISOString() : null,

    // the accepted track, with what the terrain model actually returned
    track: points.map(p => ({
      lat: p.lat, lon: p.lon, t: p.t, acc: p.acc, speed: p.speed ?? null,
      ele: p.ele, hi: p.hi ?? null, lo: p.lo ?? null, device_altitude: p.devEle ?? null,
    })),
    // every fix the receiver produced, accepted or not, with the gate's reason
    gps_fixes: fixes,

    // Strava-activity-shaped, so this drops into an existing pipeline unchanged
    streams: {
      latlng: points.map(p => [p.lat, p.lon]),
      altitude: s.smoothed.map(e => +e.toFixed(1)),
      device_altitude: points.map(p => p.devEle == null ? null : +p.devEle.toFixed(1)),
      time: points.map(p => Math.round((p.t - (points[0]?.t ?? 0)) / 1000)),
    },
  };
}

/** Full pipeline over a track of {lat,lon,t,ele}. */
export function summarize(points, { threshold = 10, window = 5 } = {}) {
  points = dropStationary(points);
  const raw = points.map(p => p.ele), ele = smooth(raw, window);
  const { gain, loss } = gainLoss(raw, threshold, window, { hi: points.map(p => p.hi), lo: points.map(p => p.lo) });
  let distance = 0;
  for (let i = 1; i < points.length; i++) distance += haversine(points[i - 1], points[i]);
  const t0 = points[0]?.t ?? 0, t1 = points.at(-1)?.t ?? 0;
  return {
    total_elevation_gain: +gain.toFixed(1),
    total_elevation_loss: +loss.toFixed(1),
    elev_high: ele.length ? +Math.max(...ele).toFixed(1) : 0,
    elev_low: ele.length ? +Math.min(...ele).toFixed(1) : 0,
    distance: +distance.toFixed(1),
    elapsed_time: Math.round((t1 - t0) / 1000),
    smoothed: ele,
  };
}
