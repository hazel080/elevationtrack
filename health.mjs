#!/usr/bin/env node
// Score a recording against Apple Health for the same stretch of time.
//
//   node health.mjs recording.json export.zip
//   node health.mjs recording.json apple_health_export/export.xml
//
// Why this is worth doing: every iPhone since the 6 has a barometer, and
// HealthKit's flightsClimbed is derived from it, fused with the accelerometer
// so lifts and escalators are filtered out. A browser cannot reach that sensor
// — no platform exposes pressure to a web page — so it is a genuinely
// INDEPENDENT reference, and the only one available for stairs, where no
// terrain model has anything to say at all.
//
// It is a reference, not a truth. HealthKit is writable by any app, so a value
// is only as good as the source that wrote it (this prints the source for every
// number). Apple counts a flight as 3 m / ~16 steps, which is a convention, not
// a measurement of the staircase you actually climbed.
//
// Android: Health Connect has the same shape (FloorsClimbedRecord,
// ElevationGainedRecord) but no stable file export to point at, and most Android
// handsets have no barometer at all, so the floors number there is usually
// derived from the same accelerometer this app already reads. Compare on iOS.

import { readFileSync, createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const FLIGHT_M = 3;   // Apple's convention: one flight = 3 m ≈ 16 steps

/** Apple writes "2026-09-10 11:04:48 +0200"; Date needs the T and no space before the zone. */
export const appleDate = (s) => new Date(String(s).replace(/^(\S+) (\S+) (\S+)$/, '$1T$2$3'));

const attr = (line, name) => line.match(new RegExp(`${name}="([^"]*)"`))?.[1];

/**
 * Scan Health export lines for everything overlapping [t0, t1].
 *
 * Streamed line by line on purpose: a couple of years of Health history is a
 * several-hundred-megabyte XML file, and every record in it is one line.
 * Workouts are the exception — their ascent arrives as a child MetadataEntry —
 * so the current workout is held open until its closing tag.
 */
export function healthScanner(t0, t1) {
  const overlaps = (a, b) => a < t1 && b > t0;
  const out = { flights: 0, steps: 0, distance: 0, workouts: [], sources: new Set() };
  let workout = null;
  return {
    result: out,
    line(line) {
      if (line.includes('<Record ')) {
        const type = attr(line, 'type');
        if (!type) return;
        const a = +appleDate(attr(line, 'startDate')), b = +appleDate(attr(line, 'endDate'));
        if (!Number.isFinite(a) || !overlaps(a, b)) return;
        const v = Number(attr(line, 'value'));
        if (!Number.isFinite(v)) return;
        if (type.endsWith('FlightsClimbed')) { out.flights += v; out.sources.add(attr(line, 'sourceName') ?? '?'); }
        else if (type.endsWith('StepCount')) out.steps += v;
        else if (type.endsWith('DistanceWalkingRunning')) out.distance += v * 1000;   // km in the export
        return;
      }
      if (line.includes('<Workout ')) {
        const a = +appleDate(attr(line, 'startDate')), b = +appleDate(attr(line, 'endDate'));
        workout = overlaps(a, b) ? {
          type: (attr(line, 'workoutActivityType') ?? '').replace('HKWorkoutActivityType', ''),
          source: attr(line, 'sourceName') ?? '?', device: attr(line, 'device') ?? '',
          minutes: (b - a) / 60000, ascent: null,
        } : null;
        // a self-closing <Workout .../> carries no metadata to wait for
        if (workout && line.trimEnd().endsWith('/>')) { out.workouts.push(workout); workout = null; }
        return;
      }
      if (!workout) return;
      if (line.includes('HKMetadataKeyElevationAscended')) {
        // value is "123 m", occasionally "123 cm" on older exports
        const raw = attr(line, 'value') ?? '';
        const n = parseFloat(raw);
        if (Number.isFinite(n)) workout.ascent = /\bcm\b/.test(raw) ? n / 100 : n;
      }
      if (line.includes('</Workout>')) { out.workouts.push(workout); workout = null; }
    },
  };
}

/** Whole-array convenience; the CLI streams instead, because these files are huge. */
export function scanHealth(lines, t0, t1) {
  const s = healthScanner(t0, t1);
  for (const l of lines) s.line(l);
  return { ...s.result, sources: [...s.result.sources] };
}

/** export.zip straight from the Health app, or the export.xml inside it. */
function healthLines(path) {
  if (!path.endsWith('.zip')) return createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  const unzip = spawn('unzip', ['-p', path, 'apple_health_export/export.xml']);
  unzip.on('error', () => { console.error('need `unzip` on PATH to read a .zip — unzip it yourself and pass export.xml'); process.exit(1); });
  return createInterface({ input: unzip.stdout, crlfDelay: Infinity });
}

// ---------- CLI ----------
if (process.argv[1]?.endsWith('health.mjs')) {
  const [rec, health] = process.argv.slice(2);
  if (!rec || !health) {
    console.error('usage: node health.mjs <recording.json> <export.zip|export.xml>');
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(rec, 'utf8'));
  const t0 = +new Date(r.start_date), t1 = t0 + r.elapsed_time * 1000;
  if (!Number.isFinite(t0)) { console.error('recording has no start_date — is this an altitrack JSON export?'); process.exit(1); }

  const pad = (s, n) => String(s).padEnd(n);
  const pct = (a, b) => (b ? `${(a - b) / b * 100 >= 0 ? '+' : ''}${((a - b) / b * 100).toFixed(1)}%` : '–');

  console.log(`${r.label ?? 'recording'}   ${new Date(t0).toISOString().slice(0, 16).replace('T', ' ')} → ${new Date(t1).toISOString().slice(11, 16)} UTC  (${Math.round(r.elapsed_time / 60)} min)`);
  if (r.device) console.log(`recorded on: ${r.device.slice(0, 90)}`);
  console.log();
  console.log(pad('  altitrack terrain', 26) + `${r.terrain_elevation_gain} m`);
  console.log(pad('  altitrack stairs', 26) + `${r.stairs?.gain ?? 0} m   (${r.stairs?.steps ?? 0} steps x ${r.stairs?.riser ?? '?'} m)`);
  console.log(pad('  altitrack total', 26) + `${r.total_elevation_gain} m`);

  const scanner = healthScanner(t0, t1);
  for await (const line of healthLines(health)) scanner.line(line);
  const h = { ...scanner.result, sources: [...scanner.result.sources] };

  console.log('\nApple Health, same window:');
  console.log(pad('  flights climbed', 26) + `${h.flights}  = ${(h.flights * FLIGHT_M).toFixed(1)} m` + (h.sources.length ? `   (${h.sources.join(', ')})` : ''));
  console.log(pad('  steps', 26) + `${h.steps}`);
  console.log(pad('  distance', 26) + `${(h.distance / 1000).toFixed(2)} km   (altitrack ${(r.distance / 1000).toFixed(2)} km)`);
  for (const w of h.workouts)
    console.log(pad(`  workout ${w.type}`, 26) + `${w.ascent == null ? 'no ascent recorded' : w.ascent.toFixed(1) + ' m'}   (${w.source}${w.device ? ', ' + (w.device.match(/name:([^,]+)/)?.[1] ?? '') : ''})`);

  console.log('\nagainst the barometer:');
  const barometric = h.workouts.find(w => w.ascent != null)?.ascent;
  if (barometric != null) console.log(pad('  terrain vs workout', 26) + pct(r.terrain_elevation_gain, barometric));
  if (h.flights) console.log(pad('  stairs vs flights', 26) + pct(r.stairs?.gain ?? 0, h.flights * FLIGHT_M));
  if (barometric == null && !h.flights) console.log('  nothing in Health for this window — was the phone recording, and is the export recent enough?');
  console.log('\nHealth is a reference, not a truth: any app can write into it, a flight is a\nflat 3 m by convention, and the barometer drifts with the weather over hours.');
}
