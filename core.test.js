const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('./core.js');

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('Wh per revolution from meter constant', () => {
  close(M.whPerRev(600), 1.6666667, 1e-6);
  close(M.whPerRev(1200), 0.8333333, 1e-6);
});

test('expected time per rev for a known load', () => {
  // 600 rev/kWh, 1000 W -> 10 rev/min -> 6 s/rev
  close(M.expectedSecPerRev(600, 1000), 6);
});

test('power from measured seconds per rev', () => {
  close(M.powerFromSecPerRev(600, 6), 1000);
});

test('meter error: faster disk means positive error', () => {
  close(M.meterErrorPct(5.7, 6), (6 / 5.7 - 1) * 100);
  assert.ok(M.meterErrorPct(5.7, 6) > 0);
});

test('correct values for a known meter error', () => {
  // meter reads +2%: each rev represents less real energy, disk spins faster
  close(M.correctedWhPerRev(600, 2), (1000 / 600) / 1.02);
  close(M.correctedSecPerRev(600, 1000, 2), 6 / 1.02);
});

test('lap stats rejects outlier laps and reports uncertainty', () => {
  const ts = [0, 6.0, 12.1, 18.0, 19.0, 24.05, 30.0]; // 19.0 is a false trigger
  const s = M.lapStats(ts, { tolerancePct: 15 });
  assert.equal(s.rejected.length >= 1, true);
  close(s.mean, 6.0, 0.1);
  assert.ok(s.ci95 > 0 && s.ci95 < 0.3);
});

test('lap stats handles too few marks', () => {
  assert.equal(M.lapStats([1]).n, 0);
});

test('detector fires once per dark pulse with hysteresis', () => {
  const d = M.createDetector({ minGapSec: 0.5, minContrast: 0.05 });
  const hits = [];
  for (let i = 0; i < 600; i++) {
    const t = i / 30;
    const phase = t % 4; // mark passes every 4 s for 0.3 s
    let v = phase < 0.3 ? 0.4 : 0.02;
    v += (i % 3) * 0.01; // noise
    const e = d.feed(t, v);
    if (e) hits.push(e.t);
  }
  assert.ok(hits.length >= 3 && hits.length <= 5, `hits=${hits}`);
  for (let i = 1; i < hits.length; i++) close(hits[i] - hits[i - 1], 4, 0.05);
});

test('detector laps are consistent with gradual edges (first pulse only calibrates)', () => {
  const d = M.createDetector({ minGapSec: 0.5 });
  const hits = [];
  const period = 6.01; // not a multiple of the frame time -> needs sub-frame interpolation
  for (let i = 0; i < 30 * 40; i++) {
    const t = i / 30;
    const ph = (t + 1) % period; // first pulse starts mid-recording
    const v = ph < 0.2 ? 0.02 + 0.5 * (ph / 0.2) : ph < 0.5 ? 0.52 : 0.02;
    const e = d.feed(t, v);
    if (e) hits.push(e.t);
  }
  assert.ok(hits.length >= 4, `hits=${hits}`);
  for (let i = 1; i < hits.length; i++) close(hits[i] - hits[i - 1], period, 0.005);
});

test('detector ignores a single-frame dropout inside a pulse', () => {
  const d = M.createDetector({ minGapSec: 0.4 });
  const hits = [];
  for (let i = 0; i < 30 * 30; i++) {
    const t = i / 30;
    const ph = (t + 4) % 6;
    let v = ph < 0.3 ? 0.7 : 0.02;
    if (Math.abs(ph - 0.1) < 0.017) v = 0; // one dropped frame mid-pulse
    const e = d.feed(t, v);
    if (e) hits.push(e.t);
  }
  assert.ok(hits.length >= 3, `hits=${hits}`);
  for (let i = 1; i < hits.length; i++) close(hits[i] - hits[i - 1], 6, 0.04);
});

// ---- ROI analyzer: compares each frame with a learned background of the box ----
// 1-D "image" helpers: ctx is the wider area around the box, roi the box itself.
const img = (n, base, dark = []) => Float32Array.from({ length: n }, (_, i) => (dark.includes(i) ? 20 : base));
const range = (a, b) => Array.from({ length: b - a }, (_, i) => a + i);

test('analyzer ignores dark things that were already in the box', () => {
  const a = M.createRoiAnalyzer();
  const staticDark = range(0, 8); // e.g. gap between disk and housing
  let maxD = 0;
  for (let i = 0; i < 120; i++) {
    const r = a.feed(i / 30, img(40, 200, staticDark), img(160, 180));
    maxD = Math.max(maxD, r.dark);
  }
  assert.ok(maxD < 0.05, `maxD=${maxD}`);
});

test('analyzer reports the mark when it enters the box', () => {
  const a = M.createRoiAnalyzer();
  for (let i = 0; i < 60; i++) a.feed(i / 30, img(40, 200, range(0, 8)), img(160, 180));
  const r = a.feed(2.1, img(40, 200, range(0, 30)), img(160, 175)); // mark covers 22 more pixels
  assert.ok(r.dark > 0.5 && !r.motion, JSON.stringify(r));
});

test('analyzer is not fooled by camera exposure changes', () => {
  const a = M.createRoiAnalyzer();
  for (let i = 0; i < 60; i++) a.feed(i / 30, img(40, 200), img(160, 180));
  const r = a.feed(2.1, img(40, 90), img(160, 81)); // whole picture ~55% darker
  assert.ok(r.dark < 0.05, JSON.stringify(r));
});

test('analyzer flags camera shake instead of counting it', () => {
  const a = M.createRoiAnalyzer();
  for (let i = 0; i < 60; i++) a.feed(i / 30, img(40, 200, range(0, 12)), img(160, 180));
  // picture shifted: the dark edge moved 12 px to the right
  const r = a.feed(2.1, img(40, 200, range(12, 24)), img(160, 180));
  assert.ok(r.motion, JSON.stringify(r));
});

test('analyzer flags shake that pushes a dark edge INTO the box', () => {
  const a = M.createRoiAnalyzer();
  // the wider area has a dark edge at 100..115; the box sees none of it
  for (let i = 0; i < 60; i++) a.feed(i / 30, img(40, 200), img(160, 190, range(100, 116)));
  // picture shifts: the edge moves 20 px into the box region, and away from where it was
  const r = a.feed(2.1, img(40, 200, range(0, 16)), img(160, 190, range(80, 96)));
  assert.ok(r.motion, JSON.stringify(r));
});

test('analyzer does not call the passing mark "motion"', () => {
  const a = M.createRoiAnalyzer();
  for (let i = 0; i < 60; i++) a.feed(i / 30, img(40, 200), img(160, 190, range(100, 116)));
  let any = false;
  for (let k = 0; k < 20; k++) { // mark sweeps through the wider area and the box
    const r = a.feed(2.1 + k / 30, img(40, 200, range(Math.max(0, k * 2 - 10), k * 2)), img(160, 190, [...range(100, 116), ...range(40 + k * 2, 50 + k * 2)]));
    any = any || r.motion;
  }
  assert.equal(any, false);
});

test('detector skip flag works like occlusion', () => {
  const d = M.createDetector({ minGapSec: 0.4 });
  let hits = 0;
  for (let i = 0; i < 300; i++) {
    const t = i / 30;
    if (d.feed(t, 0.02 + (t > 3 && t < 3.3 ? 0.9 : 0), t > 2.9 && t < 3.5)) hits++;
  }
  assert.equal(hits, 0);
});

test('detector ignores hits far earlier than the expected period', () => {
  const d = M.createDetector({ minGapSec: 0.4, expectedSec: 6 });
  const hits = [];
  for (let i = 0; i < 30 * 40; i++) {
    const t = i / 30;
    const ph = (t + 4) % 6;
    let v = ph < 0.3 ? 0.7 : 0.02;
    if (Math.abs(ph - 2.5) < 0.1) v = 0.7; // a spurious dark blip mid-rotation
    const e = d.feed(t, v);
    if (e) hits.push(e.t);
  }
  // The very first blip may slip through (nothing to compare with yet); the lap filter drops it.
  const s = M.lapStats(hits);
  assert.ok(s.n >= 3, JSON.stringify(s));
  close(s.mean, 6, 0.05);
  assert.ok(hits.filter((t, i) => i > 1 && Math.abs(((t + 4) % 6) - 2.5) < 0.2).length === 0, `hits=${hits}`);
});

test('lap stats drops a false first mark instead of the real one after it', () => {
  const s = M.lapStats([4.4, 8.0, 14.0, 20.0, 26.0, 32.0]);
  assert.equal(s.n, 4);
  close(s.mean, 6);
  assert.deepEqual(s.rejected.map((r) => r.t), [4.4]);
});

test('detector ignores full-window occlusion (hand / shadow)', () => {
  const d = M.createDetector({ minGapSec: 0.5, minContrast: 0.05 });
  let hits = 0;
  for (let i = 0; i < 300; i++) {
    const t = i / 30;
    const v = t > 3 && t < 4 ? 0.95 : 0.02;
    if (d.feed(t, v)) hits++;
  }
  assert.equal(hits, 0);
});
