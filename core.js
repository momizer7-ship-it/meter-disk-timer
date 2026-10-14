// Meter disk math + mark detection. Pure functions, no DOM.
const MeterCore = (() => {
  const whPerRev = (k) => 1000 / k;
  const expectedSecPerRev = (k, watts) => 3.6e6 / (k * watts);
  const powerFromSecPerRev = (k, sec) => 3.6e6 / (k * sec);
  // Positive = meter registers more than the true energy (disk too fast).
  const meterErrorPct = (measuredSec, expectedSec) => (expectedSec / measuredSec - 1) * 100;
  const correctedWhPerRev = (k, errPct) => whPerRev(k) / (1 + errPct / 100);
  const correctedSecPerRev = (k, watts, errPct) => expectedSecPerRev(k, watts) / (1 + errPct / 100);

  // Two-sided 95% Student-t critical values, df 1..30.
  const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228,
    2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086,
    2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042];
  const tCrit = (df) => (df < 1 ? NaN : df <= 30 ? T95[df - 1] : 1.96);

  const median = (xs) => {
    if (!xs.length) return NaN;
    const s = [...xs].sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };

  // timestamps: seconds at which the mark passed. Drops marks that arrive too
  // early (false triggers) and laps that are too long (missed marks).
  function lapStats(timestamps, { tolerancePct = 15 } = {}) {
    const ts = [...timestamps].sort((a, b) => a - b);
    const empty = { n: 0, laps: [], rejected: [], mean: NaN, sd: NaN, ci95: NaN, relPct: NaN };
    if (ts.length < 2) return empty;
    const raw = [];
    for (let i = 1; i < ts.length; i++) raw.push(ts[i] - ts[i - 1]);
    const ref = median(raw);
    const lo = ref * (1 - tolerancePct / 100);
    const hi = ref * (1 + tolerancePct / 100);
    const laps = [];
    const rejected = [];
    let last = ts[0];
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - last;
      if (gap < lo) { rejected.push({ t: ts[i], reason: 'early' }); continue; }
      if (gap > hi) rejected.push({ t: ts[i], reason: 'long' });
      else laps.push(gap);
      last = ts[i];
    }
    const n = laps.length;
    if (!n) return { ...empty, rejected };
    const mean = laps.reduce((a, b) => a + b, 0) / n;
    const sd = n > 1 ? Math.sqrt(laps.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : NaN;
    const ci95 = n > 1 ? tCrit(n - 1) * sd / Math.sqrt(n) : NaN;
    return { n, laps, rejected, mean, sd, ci95, relPct: (ci95 / mean) * 100 };
  }

  // Feed it (time, darkFraction) per frame, where darkFraction is the share of
  // pixels inside the selected window that are much darker than the window's
  // own brightness. Fires once on each rising edge of the black mark.
  function createDetector({
    windowSec = 15, minContrast = 0.03, onLevel = 0.6, offLevel = 0.35,
    minGapSec = 0.4, occlusion = 0.85, minOffFrames = 3,
  } = {}) {
    let samples = [];
    let active = false;
    let armed = false; // the first pulse only teaches how dark the mark gets
    let lastHit = -Infinity;
    let prev = null;
    let offCount = 0;
    const hits = [];
    return {
      get armed() { return armed; },
      feed(t, v) {
        if (v >= occlusion) { active = true; prev = null; return null; } // hand/shadow over whole window
        const before = prev;
        prev = [t, v];
        samples.push([t, v]);
        while (samples.length && samples[0][0] < t - windowSec) samples.shift();
        let min = Infinity, max = -Infinity;
        for (const [, x] of samples) { if (x < min) min = x; if (x > max) max = x; }
        const range = max - min;
        const state = { min, max, range, on: min + onLevel * range, off: min + offLevel * range };
        if (active) {
          // The mark must stay gone for minOffFrames frames, so a dropped frame mid-pulse is not a new pulse.
          offCount = v <= state.off || range < minContrast ? offCount + 1 : 0;
          if (offCount >= minOffFrames) { active = false; offCount = 0; armed = armed || range >= minContrast; }
          return null;
        }
        if (range < minContrast || v < state.on) return null;
        active = true;
        if (!armed) return null;
        // Interpolate the moment the signal crossed the "on" level between frames.
        let tc = t;
        if (before && before[1] < state.on && v > before[1]) {
          tc = before[0] + (state.on - before[1]) / (v - before[1]) * (t - before[0]);
        }
        const recent = [];
        for (let i = Math.max(1, hits.length - 5); i < hits.length; i++) recent.push(hits[i] - hits[i - 1]);
        const gap = Math.max(minGapSec, recent.length >= 2 ? 0.5 * median(recent) : 0);
        if (tc - lastHit < gap) return null;
        lastHit = tc;
        hits.push(tc);
        return { t: tc, ...state };
      },
      reset() { samples = []; active = false; armed = false; prev = null; offCount = 0; lastHit = -Infinity; hits.length = 0; },
    };
  }

  // Share of pixels (RGBA array) darker than `ratio` x the window's mean luma.
  function darkFraction(rgba, ratio = 0.55) {
    const n = rgba.length / 4;
    const luma = new Float32Array(n);
    let sum = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      const y = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      luma[j] = y; sum += y;
    }
    const mean = sum / n;
    if (mean < 12) return 1; // window is basically black: treat as occluded
    const thr = mean * ratio;
    let dark = 0;
    for (let j = 0; j < n; j++) if (luma[j] < thr) dark++;
    return dark / n;
  }

  return {
    whPerRev, expectedSecPerRev, powerFromSecPerRev, meterErrorPct,
    correctedWhPerRev, correctedSecPerRev, lapStats, createDetector, darkFraction, median,
  };
})();
if (typeof module !== 'undefined') module.exports = MeterCore;
