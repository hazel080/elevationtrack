#!/usr/bin/env node
// Re-derive a recorded track's elevation gain from several INDEPENDENT terrain
// datasets and several algorithms, so the spread is visible instead of assumed.
//
//   node compare.mjs track.json  [--truth 350]
//   node compare.mjs track.gpx   [--truth 350]
//
// --truth is the surveyed gain of the route, if you know it. See README.

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { gainLoss, providerFor, wgs84ToLv95 } from './altitude.js';

const file = process.argv[2];
const truthArg = process.argv.indexOf('--truth');
const TRUTH = truthArg > -1 ? Number(process.argv[truthArg + 1]) : null;
if (!file) { console.error('usage: node compare.mjs <track.json|track.gpx> [--truth metres]'); process.exit(1); }

// ---------- load ----------
const text = readFileSync(file, 'utf8');
let coords, deviceEle = null;
if (file.endsWith('.gpx')) {
  coords = [...text.matchAll(/<trkpt[^>]*lat="([-\d.]+)"[^>]*lon="([-\d.]+)"/g)].map(m => [+m[1], +m[2]]);
  const eles = [...text.matchAll(/<ele>([-\d.]+)<\/ele>/g)].map(m => +m[1]);
  if (eles.length === coords.length) deviceEle = eles;
} else {
  const j = JSON.parse(text);
  coords = j.streams?.latlng ?? j.map(p => [p.lat, p.lon]);
  deviceEle = j.streams?.device_altitude?.every(v => v != null) ? j.streams.device_altitude : null;
}
if (!coords?.length) { console.error('no points found in ' + file); process.exit(1); }
console.log(`${coords.length} track points from ${file}`);

// ---------- terrain datasets ----------
const curl = (url) => JSON.parse(execFileSync('curl', ['-sfL', '-m', '60', url], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// opentopodata: 100 locations per call, ~1 call/sec on the free endpoint
function openTopo(dataset) {
  const out = [];
  for (let i = 0; i < coords.length; i += 100) {
    const batch = coords.slice(i, i + 100).map(([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`).join('|');
    const r = curl(`https://api.opentopodata.org/v1/${dataset}?locations=${batch}`);
    for (const x of r.results) out.push(x.elevation);
    sleep(1100);
    process.stderr.write(`\r  ${dataset}: ${out.length}/${coords.length}`);
  }
  process.stderr.write('\n');
  return out;
}

// swisstopo swissALTI3D — airborne LiDAR, the most accurate terrain data available
// anywhere for the area it covers. Needs LV95 coordinates.
const inSwitzerland = coords.every(([la, lo]) => la > 45.8 && la < 47.9 && lo > 5.9 && lo < 10.6);
function swisstopo() {
  const out = [];
  for (const [lat, lon] of coords) {
    const [E, N] = wgs84ToLv95(lat, lon);
    try { out.push(Number(curl(`https://api3.geo.admin.ch/rest/services/height?easting=${E.toFixed(1)}&northing=${N.toFixed(1)}`).height)); }
    catch { out.push(null); }
    if (out.length % 25 === 0) process.stderr.write(`\r  swisstopo: ${out.length}/${coords.length}`);
  }
  process.stderr.write('\n');
  return out.some(v => v == null) ? null : out;
}

// Spain: IGN MDT, 5 m LiDAR-derived terrain model. One request per point.
const inSpain = coords.every(([la, lo]) => providerFor(la, lo) === 'ign');
const ignAt = ([lat, lon]) => {
  const d = 0.00005;
  const q = `service=WMS&version=1.3.0&request=GetFeatureInfo&layers=EL.ElevationGridCoverage` +
    `&query_layers=EL.ElevationGridCoverage&crs=EPSG:4326&bbox=${lat-d},${lon-d},${lat+d},${lon+d}` +
    `&width=3&height=3&i=1&j=1&info_format=text/plain`;
  const txt = execFileSync('curl', ['-sfL', '-m', '30', `https://servicios.idee.es/wms-inspire/mdt?${q}`], { encoding: 'utf8' });
  const m = txt.match(/GRAY_INDEX\s*=\s*(-?[\d.]+)/);
  const v = m ? Number(m[1]) : NaN;
  return (Number.isFinite(v) && v > -50 && v < 4000) ? v : null;
};
function ign() {
  const out = [];
  for (const c of coords) {
    try { out.push(ignAt(c)); } catch { out.push(null); }
    if (out.length % 25 === 0) process.stderr.write(`\r  IGN: ${out.length}/${coords.length}`);
  }
  process.stderr.write('\n');
  return out.some(v => v == null) ? null : out;
}

// ---------- algorithms ----------
const raw = (e) => { let g = 0; for (let i = 1; i < e.length; i++) if (e[i] > e[i-1]) g += e[i] - e[i-1]; return g; };
const gpxpy = (e) => {   // what the most-used GPX library does: 3-tap filter, NO threshold
  const s = e.map((v, i) => (i > 0 && i < e.length - 1) ? e[i-1]*.3 + v*.4 + e[i+1]*.3 : v);
  return raw(s);
};
const ours = (e, w = 5, t = 10) => gainLoss(e, t, w).gain;

// ---------- run ----------
// mapzen, srtm30m and aster30m are global; eudem25m is Europe only and would
// just fail elsewhere, so it is offered only where it has data.
const inEurope = coords.every(([la, lo]) => la > 34 && la < 72 && lo > -25 && lo < 45);
const sources = { 'mapzen (what the app uses)': () => openTopo('mapzen'), 'srtm30m': () => openTopo('srtm30m'), 'aster30m': () => openTopo('aster30m') };
if (inEurope) sources['eudem25m'] = () => openTopo('eudem25m');
if (inSwitzerland) sources['swisstopo LiDAR 0.5m'] = swisstopo;
if (inSpain) sources['IGN MDT 5m LiDAR'] = ign;
if (deviceEle) sources['phone GPS altitude'] = () => deviceEle;

const rows = [];
for (const [name, fn] of Object.entries(sources)) {
  let e; try { e = fn(); } catch (err) { console.error(`  ${name}: failed (${err.message.slice(0,60)})`); continue; }
  if (!e || e.some(v => typeof v !== 'number' || !Number.isFinite(v))) { console.error(`  ${name}: no data for this area`); continue; }
  rows.push({ name, ours: ours(e), noThresh: gpxpy(e), rawSum: raw(e) });
}

const pad = (s, n) => String(s).padEnd(n);
const num = (v) => (v == null ? '–' : v.toFixed(0));
console.log('\n' + pad('terrain source', 28) + '  ours'.padStart(8) + ' gpxpy'.padStart(8) + ' raw sum'.padStart(8));
console.log('-'.repeat(56));
for (const r of rows) console.log(pad(r.name, 28) + num(r.ours).padStart(8) + num(r.noThresh).padStart(8) + num(r.rawSum).padStart(8));
console.log('\nours    = smoothing + 10 m threshold (this app)');
console.log('gpxpy   = 3-tap filter, no threshold (the popular GPX library)');
console.log('raw sum = every positive delta, no filtering at all');

if (TRUTH != null) {
  console.log(`\nsurveyed truth: ${TRUTH} m`);
  for (const r of rows) console.log(`  ${pad(r.name, 28)} ours ${((r.ours - TRUTH) / TRUTH * 100).toFixed(1).padStart(6)}%   gpxpy ${((r.noThresh - TRUTH) / TRUTH * 100).toFixed(1).padStart(7)}%`);
}
// For a single continuous climb, the surveyed endpoint difference IS the true
// gain — no smoothing or threshold choices can influence it. That makes it the
// only reference number in this whole exercise that is not itself an estimate.
if (TRUTH == null && inSpain) {
  try {
    const a = ignAt(coords[0]), b = ignAt(coords.at(-1));
    if (a != null && b != null) {
      console.log(`\nIGN surveyed endpoints: ${a.toFixed(1)} m -> ${b.toFixed(1)} m  (delta ${(b - a).toFixed(1)} m)`);
      console.log('If this route was ONE continuous climb, that delta is the true gain.');
    }
  } catch {}
}
if (TRUTH == null && inSwitzerland) {
  try {
    const at = ([lat, lon]) => { const [E, N] = wgs84ToLv95(lat, lon);
      return Number(curl(`https://api3.geo.admin.ch/rest/services/height?easting=${E.toFixed(1)}&northing=${N.toFixed(1)}`).height); };
    const a = at(coords[0]), b = at(coords.at(-1));
    console.log(`\nswisstopo surveyed endpoints: ${a.toFixed(1)} m -> ${b.toFixed(1)} m  (delta ${(b - a).toFixed(1)} m)`);
    console.log('If this route was ONE continuous climb, that delta is the true gain.');
  } catch {}
}

if (rows.length > 1) {
  const vals = rows.filter(r => !r.name.startsWith('phone')).map(r => r.ours);
  console.log(`\nspread across terrain datasets (our algorithm): ${Math.min(...vals).toFixed(0)}–${Math.max(...vals).toFixed(0)} m` +
    ` (${((Math.max(...vals) - Math.min(...vals)) / Math.min(...vals) * 100).toFixed(1)}%)`);
  console.log('That spread is the floor on how well ANY tool can agree with any other.');
}
