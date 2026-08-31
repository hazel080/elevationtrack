import assert from 'node:assert';
import { decodeTerrarium, gainLoss, smooth, sampleBilinear, summarize, haversine } from './altitude.js';

// terrarium encoding: sea level is (32768 -> R=128,G=0,B=0)
assert.strictEqual(decodeTerrarium(128, 0, 0), 0);
assert.strictEqual(decodeTerrarium(128, 100, 0), 100);

// bilinear midpoint of a 0/100 ramp
const ramp = (px) => px * 100;
assert.ok(Math.abs(sampleBilinear((x) => ramp(x), 1.0, 0.5) - 50) < 1e-9);

// --- the real check: 10 laps of a 100 m hill = 1000 m gain ---
// realistic: 1 Hz samples, ~0.3 m/s vertical (a brisk walk up a steep path)
const STEP = 0.3, N = Math.round(100 / STEP);
const lap = [];
for (let i = 0; i <= N; i++) lap.push(i * STEP);        // 0 -> 100
for (let i = N - 1; i >= 0; i--) lap.push(i * STEP);    // 100 -> 0
const clean = Array.from({ length: 10 }, () => lap).flat();
let r = gainLoss(clean, 10);
assert.ok(Math.abs(r.gain - 1000) < 25, `clean gain ${r.gain}`);
assert.ok(Math.abs(r.loss - 1000) < 25, `clean loss ${r.loss}`);

// same hill with +/-3 m jitter: gain must NOT inflate (this is saw-toothing)
// mulberry32 — stays inside 32-bit via Math.imul, so it cannot lose precision.
let seed = 42;
const rnd = () => {
  seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5;   // uniform in [-0.5, 0.5)
};
{ // the generator itself must be sane before any test leans on it
  const v = Array.from({ length: 20000 }, rnd);
  const mean = v.reduce((a, b) => a + b) / v.length;
  assert.ok(Math.abs(mean) < 0.01, `PRNG biased: mean ${mean}`);
  assert.ok(Math.min(...v) < -0.49 && Math.max(...v) > 0.49, 'PRNG range collapsed');
  assert.strictEqual(new Set(v).size, v.length, 'PRNG cycled');
}
const noisy = clean.map(e => e + rnd() * 6);
r = gainLoss(smooth(noisy, 11), 10);
assert.ok(Math.abs(r.gain - 1000) < 60, `noisy gain ${r.gain} (saw-tooth leaked in)`);
assert.ok(Math.abs(r.loss - 1000) < 60, `noisy loss ${r.loss}`);

// Standing still on flat terrain. DEM elevation is a function of POSITION, so
// horizontal GPS jitter of ~10 m on flat ground moves elevation by ~1-2 m,
// not the +/-10 m that raw GPS altitude would wander. 33 min of it must read ~0.
const flatNoisy = Array.from({ length: 2000 }, () => 500 + rnd() * 4);
r = gainLoss(smooth(flatNoisy, 11), 10);
assert.ok(r.gain < 10, `phantom gain on flat ground: ${r.gain}`);

// ponytail: known ceiling -- at +/-8 m noise (raw-GPS-altitude grade) phantom gain
// reaches ~40 m/30 min. That is the reason we use DEM, not device altitude.

// no-threshold control: proves the threshold is what's doing the work
assert.ok(gainLoss(flatNoisy, 0).gain > 200, 'unthresholded flat noise should inflate');

// haversine sanity: 0.01 deg lat ~ 1111 m
assert.ok(Math.abs(haversine({lat:47,lon:8},{lat:47.01,lon:8}) - 1111) < 5);

// summarize shape
const pts = clean.map((ele, i) => ({ lat: 47 + i * 1e-5, lon: 8, t: i * 1000, ele }));
const s = summarize(pts);
assert.ok(s.total_elevation_gain > 950, `summarize gain ${s.total_elevation_gain}`);
assert.ok(s.elev_high > 99 && s.elev_high <= 100, `elev_high ${s.elev_high}`); // smoothing rounds the apex
assert.strictEqual(s.elapsed_time, clean.length - 1);

console.log('all checks passed');

// ---------------------------------------------------------------------------
// Regression: the "93 m while standing still" report.
// Standing on a 30% slope for 10 min with 20 m-accuracy fixes (which the old
// gate accepted) drifting at 1 Hz.
// The DEM correctly turns horizontal jitter into vertical swings, so without a
// movement gate this manufactures elevation out of nothing.
// ---------------------------------------------------------------------------
{
  const { shouldAccept, hasSettled } = await import('./altitude.js');
  const SLOPE = 0.30, BASE = { lat: 47.05, lon: 8.31 };
  const demAt = (lat) => 500 + (lat - BASE.lat) * 111320 * SLOPE; // slope runs N-S

  // Real GPS position does not jump around a fixed point — it *wanders*, a
  // correlated random walk of tens of metres. That drift is what fakes climbing.
  // Phantom movement lands in gain or loss depending on which way the drift
  // happened to wander, so measure both, across several independent walks.
  let ungatedPhantom = 0, gatedPhantom = 0, gatedPoints = 0;
  for (let run = 0; run < 5; run++) {
    const raw = [];
    let dn = 0, de = 0;
    for (let i = 0; i < 600; i++) {
      dn = Math.max(-60, Math.min(60, dn + rnd() * 8));   // metres north, bounded drift
      de = Math.max(-60, Math.min(60, de + rnd() * 8));
      raw.push({ lat: BASE.lat + dn / 111320, lon: BASE.lon + de / 75000, acc: 20, t: i * 1000 });
    }
    const u = summarize(raw.map(f => ({ ...f, ele: demAt(f.lat) })));
    ungatedPhantom += u.total_elevation_gain + u.total_elevation_loss;

    const kept = [];
    for (const f of raw) if (shouldAccept(kept.at(-1), f) === true) kept.push({ ...f, ele: demAt(f.lat) });
    gatedPoints += kept.length;
    if (kept.length) {
      const g = summarize(kept);
      gatedPhantom += g.total_elevation_gain + g.total_elevation_loss;
    }
  }
  assert.ok(ungatedPhantom > 50, `old code should hallucinate movement, got ${ungatedPhantom}`);
  // Spec: under 0.5 m of phantom movement per stationary minute, worst case.
  assert.ok(gatedPhantom < 25, `gated hallucinates ${gatedPhantom} m over 50 min (${gatedPoints} points)`);
  console.log(`  50 min standing on a 30% slope: ${ungatedPhantom.toFixed(0)} m phantom -> ${gatedPhantom.toFixed(0)} m (${gatedPoints} points kept)`);

  // gate reasons
  assert.strictEqual(shouldAccept(null, { lat: 47, lon: 8, acc: 60, t: 0 }), 'accuracy');
  assert.strictEqual(shouldAccept({ lat: 47, lon: 8, acc: 10, t: 0 },
                                  { lat: 47.02, lon: 8, acc: 10, t: 1000 }), 'teleport'); // 2.2 km in 1 s
  assert.strictEqual(shouldAccept({ lat: 47, lon: 8, acc: 10, t: 0 },
                                  { lat: 47.00003, lon: 8, acc: 10, t: 1000 }), 'stationary'); // 3 m
  assert.strictEqual(shouldAccept({ lat: 47, lon: 8, acc: 10, t: 0 },
                                  { lat: 47.0002, lon: 8, acc: 10, t: 5000 }), true); // 22 m in 5 s

  // cold start: a coarse fix 400 m away must not count as settled
  assert.ok(!hasSettled([{ lat: 47, lon: 8 }, { lat: 47.004, lon: 8 }, { lat: 47.0001, lon: 8 }]));
  assert.ok(hasSettled([{ lat: 47, lon: 8 }, { lat: 47.0001, lon: 8 }, { lat: 47.0002, lon: 8 }]));
}

// ---------------------------------------------------------------------------
// Real climbing must survive the gate: 10 laps of a 100 m hill at 10% grade,
// sampled every ~10 m of travel (which is what the movement gate produces).
// ---------------------------------------------------------------------------
{
  const { shouldAccept } = await import('./altitude.js');
  const pts = [];
  let lat = 47.05, t = 0;
  for (let lap = 0; lap < 10; lap++) {
    for (const dir of [1, -1]) {
      for (let i = 0; i < 100; i++) {       // 100 samples x 10 m = 1000 m horizontal
        lat += (dir * 10) / 111320;
        pts.push({ lat, lon: 8.31, acc: 8, t: (t += 2000) });
      }
    }
  }
  const demAt = (la) => 500 + Math.abs((la - 47.05) * 111320) * 0.10;
  const kept = [];
  for (const f of pts) if (shouldAccept(kept.at(-1), f) === true) kept.push({ ...f, ele: demAt(f.lat) });
  // The gate subsamples (it measures from the last ACCEPTED point, so rejected
  // fixes are not lost — their distance carries forward), but must not starve.
  assert.ok(kept.length > pts.length * 0.4, `gate kept only ${kept.length}/${pts.length}`);
  const s = summarize(kept);
  // The requirement is asymmetric on purpose. Overcounting is an integrity
  // failure — it is how a rider banks metres they never climbed. Undercounting is
  // a known, systematic smoothing bias that field calibration removes. So: never
  // above truth, and no worse than 10% below it.
  for (const [what, v] of [['gain', s.total_elevation_gain], ['loss', s.total_elevation_loss]]) {
    assert.ok(v <= 1000, `OVERCOUNTED ${what}: ${v} > 1000`);
    assert.ok(v >= 900, `${what} undercounts beyond the calibratable band: ${v}`);
  }
  console.log(`  10 hill repeats through the gate: +${s.total_elevation_gain} / -${s.total_elevation_loss} m`);
}

console.log('gate checks passed');
