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

/**
 * Centred moving average, window in samples.
 * Wider = less phantom gain but more clipping of real summits (w=3 measured
 * -2.8% on real climbs but let phantom gain reach 39 m/50 min; w=5 costs -4.8%
 * and holds phantom near 11 m). A median filter was tried and was not better on
 * either axis. Phantom gain is the integrity risk, so we pay the undercount and
 * calibrate it out in the field.
 */
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
 * Peak-valley accumulator. Tracks the running extremum and only commits a leg
 * once the track reverses by more than `threshold` — so jitter (and saw-toothing)
 * never reverses direction, but a real turnaround is counted at full amplitude.
 */
export function gainLoss(elevations, threshold = 10) {
  if (elevations.length === 0) return { gain: 0, loss: 0 };
  let gain = 0, loss = 0, dir = 0;
  let anchor = elevations[0], ext = elevations[0];
  let lo = elevations[0], hi = elevations[0]; // extremes while direction unknown

  for (const e of elevations) {
    if (dir === 0) {
      if (e < lo) lo = e;
      if (e > hi) hi = e;
      if (e >= lo + threshold) { dir = 1; anchor = lo; ext = e; }
      else if (e <= hi - threshold) { dir = -1; anchor = hi; ext = e; }
    } else if (dir === 1) {
      if (e > ext) ext = e;
      else if (e <= ext - threshold) { gain += ext - anchor; anchor = ext; ext = e; dir = -1; }
    } else {
      if (e < ext) ext = e;
      else if (e >= ext + threshold) { loss += anchor - ext; anchor = ext; ext = e; dir = 1; }
    }
  }
  if (dir === 1) gain += ext - anchor;
  else if (dir === -1) loss += anchor - ext;
  return { gain, loss };
}

/**
 * Gate on a raw GPS fix before it ever reaches the elevation math.
 * Returns true, or a string reason. This is where accuracy is won or lost:
 * a fix that is merely imprecise still produces a plausible-looking elevation,
 * so it has to be rejected here, not smoothed away later.
 */
export function shouldAccept(last, fix, { minMove = 10, accFactor = 1.5, maxAccuracy = 20, maxSpeed = 30 } = {}) {
  if (!(fix.acc <= maxAccuracy)) return 'accuracy';
  if (!last) return true;
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

export function haversine(a, b) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad, dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Full pipeline over a track of {lat,lon,t,ele}. */
export function summarize(points, { threshold = 10, window = 5 } = {}) {
  const ele = smooth(points.map(p => p.ele), window);
  const { gain, loss } = gainLoss(ele, threshold);
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
