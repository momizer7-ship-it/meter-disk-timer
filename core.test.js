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
