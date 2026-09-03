import assert from 'node:assert';
import { decodeTerrarium, gainLoss, smooth, sampleBilinear, summarize, haversine, wgs84ToLv95, segmentSamples } from './altitude.js';

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
r = gainLoss(noisy, 10, 11);
assert.ok(Math.abs(r.gain - 1000) < 60, `noisy gain ${r.gain} (saw-tooth leaked in)`);
assert.ok(Math.abs(r.loss - 1000) < 60, `noisy loss ${r.loss}`);

// Standing still on flat terrain. DEM elevation is a function of POSITION, so
// horizontal GPS jitter of ~10 m on flat ground moves elevation by ~1-2 m,
// not the +/-10 m that raw GPS altitude would wander. 33 min of it must read ~0.
const flatNoisy = Array.from({ length: 2000 }, () => 500 + rnd() * 4);
r = gainLoss(flatNoisy, 10, 11);
assert.ok(r.gain < 10, `phantom gain on flat ground: ${r.gain}`);

// ponytail: known ceiling -- at +/-8 m noise (raw-GPS-altitude grade) phantom gain
// reaches ~40 m/30 min. That is the reason we use DEM, not device altitude.

// no-threshold control: proves the threshold is what's doing the work
assert.ok(gainLoss(flatNoisy, 0, 1).gain > 200, 'unthresholded flat noise should inflate');

// What the app does per accepted fix: scan the terrain along the segment from
// the previous point and keep the interior extremes.
const scan = (last, f, demAt, step = 5) => {
  const e = segmentSamples(last, f, step).map(demAt);
  return e.length ? { hi: Math.max(...e), lo: Math.min(...e) } : {};
};
{ // 3 interior samples for a 20 m segment at 5 m steps, evenly spaced
  const ss = segmentSamples({ lat: 47, lon: 8 }, { lat: 47.00018, lon: 8 }, 5);
  assert.strictEqual(ss.length, 4);
  assert.ok(Math.abs(ss[1].lat - 47.000072) < 1e-6, `segment sample ${ss[1].lat}`);
}

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
    for (const f of raw) if (shouldAccept(kept.at(-1), f) === true) kept.push({ ...f, ele: demAt(f.lat), ...(kept.length ? scan(kept.at(-1), f, p => demAt(p.lat)) : {}) });
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
  for (const f of pts) if (shouldAccept(kept.at(-1), f) === true) kept.push({ ...f, ele: demAt(f.lat), ...(kept.length ? scan(kept.at(-1), f, p => demAt(p.lat)) : {}) });
  // The gate subsamples (it measures from the last ACCEPTED point, so rejected
  // fixes are not lost — their distance carries forward), but must not starve.
  assert.ok(kept.length > pts.length * 0.4, `gate kept only ${kept.length}/${pts.length}`);
  const s = summarize(kept);
  // This is an out-and-back on a line: the summit is the TURNAROUND, so the
  // straight-line scan between the fixes before and after cannot see it. The
  // last accepted fix is at most one gate distance short of the top, which is
  // the 2% here. A crossed summit (see the rolling test) is recovered by the scan.
  // The requirement is asymmetric on purpose. Overcounting is an integrity
  // failure — it is how a rider banks metres they never climbed. Undercounting is
  // a known, systematic smoothing bias that field calibration removes. So: never
  // above truth, and no worse than 10% below it.
  for (const [what, v] of [['gain', s.total_elevation_gain], ['loss', s.total_elevation_loss]]) {
    assert.ok(v <= 1000, `OVERCOUNTED ${what}: ${v} > 1000`);
    assert.ok(v >= 975, `${what} undercounts beyond the calibratable band: ${v}`);
  }
  console.log(`  10 hill repeats through the gate: +${s.total_elevation_gain} / -${s.total_elevation_loss} m`);
}

// Rolling terrain: 15 m sine hills, 300 m period, 10 km, walked with 8 m GPS
// noise. Truth = 2 x 15 m x 33.3 hills = 1000 m. Reading amplitude from the
// SMOOTHED series clipped every apex and read 903 here; the bias scaled with the
// number of extrema, so it could not be calibrated out.
{
  const { shouldAccept } = await import('./altitude.js');
  const kept = []; let last = null, x = 0, t = 0;
  while (x < 10000) {
    x += 2.8;
    const f = { lat: 47.05 + x / 111320, lon: 8.31, acc: 8, t: (t += 2000) };
    const dem = (p) => 500 + 15 * Math.sin(2 * Math.PI * ((p.lat - 47.05) * 111320 + rnd() * 8) / 300);
    if (shouldAccept(last, f) === true) { kept.push({ ...f, ele: dem(f), ...(last ? scan(last, f, dem) : {}) }); last = f; }
  }
  const s = summarize(kept);
  assert.ok(s.total_elevation_gain <= 1000, `OVERCOUNTED rolling: ${s.total_elevation_gain}`);
  assert.ok(s.total_elevation_gain >= 985, `rolling undercounts: ${s.total_elevation_gain}`);
  console.log(`  10 km of 15 m rolling hills: +${s.total_elevation_gain} m (true 1000)`);

  // Same idea with bad GPS (20 m accuracy => fixes 30 m apart) on 30 m hills of
  // 200 m period: the summit is crossed between fixes almost every time. Without
  // the segment scan this read 2753 of 3000.
  const kept2 = []; last = null; x = 0;
  while (x < 10000) {
    x += 2.8;
    const f = { lat: 47.05 + x / 111320, lon: 8.31, acc: 20, t: (t += 2000) };
    const dem = (p) => 500 + 30 * Math.sin(2 * Math.PI * ((p.lat - 47.05) * 111320 + rnd() * 20) / 200);
    if (shouldAccept(last, f) === true) { kept2.push({ ...f, ele: dem(f), ...(last ? scan(last, f, dem) : {}) }); last = f; }
  }
  const g2 = summarize(kept2).total_elevation_gain;
  assert.ok(g2 <= 3000, `OVERCOUNTED rolling/bad GPS: ${g2}`);
  assert.ok(g2 >= 2900, `rolling/bad GPS undercounts: ${g2}`);
  console.log(`  10 km of 30 m hills with 20 m GPS accuracy: +${g2} m (true 3000)`);

  // Doppler speed gate: a drifting fix that reports ~0 m/s is standing still.
  assert.strictEqual(shouldAccept({ lat: 47, lon: 8, acc: 10, t: 0 },
                                  { lat: 47.0005, lon: 8, acc: 10, t: 5000, speed: 0 }), 'stationary');
  assert.strictEqual(shouldAccept({ lat: 47, lon: 8, acc: 10, t: 0 },
                                  { lat: 47.0002, lon: 8, acc: 10, t: 5000, speed: -1 }), true);  // -1 = not reported
  assert.strictEqual(shouldAccept({ lat: 47, lon: 8, acc: 10, t: 0 },
                                  { lat: 47.0002, lon: 8, acc: 10, t: 5000, speed: null }), true);
}

// Stationary episodes: a 3 min rest at the bottom of a 30% hill with 30 m of
// GPS wander must add nothing, while the hill repeat around it is untouched.
{
  const { shouldAccept, dropStationary } = await import('./altitude.js');
  const demAt = (la) => 500 + Math.abs((la - 47.05) * 111320) * 0.30;
  const raw = []; let lat = 47.05, t = 0;
  const walk = (dir, n) => { for (let i = 0; i < n; i++) { lat += (dir * 10) / 111320; raw.push({ lat, lon: 8.31, acc: 8, t: (t += 5000) }); } };
  const rest = (secs) => { let dn = 0, de = 0; for (let i = 0; i < secs; i++) { dn = Math.max(-30, Math.min(30, dn + rnd() * 8)); de = Math.max(-30, Math.min(30, de + rnd() * 8));
    raw.push({ lat: lat + dn / 111320, lon: 8.31 + de / 75000, acc: 15, t: (t += 1000) }); } };
  const gate = (fixes) => { const k = []; for (const f of fixes) if (shouldAccept(k.at(-1), f) === true) k.push({ ...f, ele: demAt(f.lat) }); return k; };
  walk(1, 100); walk(-1, 100); const restAt = raw.length; rest(180); walk(1, 100); walk(-1, 100);   // 2 x 300 m climb, rest between
  const kept = gate(raw);
  const collapsed = dropStationary(kept);
  assert.ok(collapsed.length < kept.length, 'rest was not detected');
  const s = summarize(kept);
  // reference: the identical track with the rest cut out (time shifted so the gate sees the same thing)
  const noRest = gate([...raw.slice(0, restAt), ...raw.slice(restAt + 180).map(f => ({ ...f, t: f.t - 180000 }))]);
  const ref = summarize(noRest).total_elevation_gain;
  assert.ok(s.total_elevation_gain <= ref + 0.5, `rest leaked into gain: ${s.total_elevation_gain} vs ${ref} without the rest`);
  assert.ok(s.total_elevation_gain >= ref - 6, `rest ate real gain: ${s.total_elevation_gain} vs ${ref}`);
  // no episode: a real climb passes through untouched
  const climb = Array.from({ length: 50 }, (_, i) => ({ lat: 47.05 + i * 15 / 111320, lon: 8.31, t: i * 10000, ele: 500 + i }));
  assert.strictEqual(dropStationary(climb).length, 50);
  console.log(`  2 hill repeats with a 3 min rest between: +${s.total_elevation_gain} m (${ref} without the rest), ${kept.length - collapsed.length} wander points dropped`);
}

// LV95: Bern old observatory is the datum origin, E 2600000 / N 1200000
{
  const [E, N] = wgs84ToLv95(46.951082877, 7.438632495);
  assert.ok(Math.abs(E - 2600000) < 2 && Math.abs(N - 1200000) < 2, `lv95 ${E},${N}`);
}

// provider routing
{
  const { providerFor } = await import('./altitude.js');
  assert.strictEqual(providerFor(41.3874, 2.1686), 'ign');        // Barcelona
  assert.strictEqual(providerFor(40.4168, -3.7038), 'ign');       // Madrid
  assert.strictEqual(providerFor(47.05, 8.31), 'swisstopo');      // Luzern
  assert.strictEqual(providerFor(45.4642, 9.19), 'terrarium');    // Milan
  assert.strictEqual(providerFor(-33.86, 151.2), 'terrarium');    // Sydney
}

console.log('gate checks passed');
