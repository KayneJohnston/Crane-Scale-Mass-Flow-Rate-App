// Post-session analysis of a saved session (uses all the data, not just the past).
//
// Per tap ("flow segment"):
//   * start / end: change-point (hinge) fits on the accepted readings;
//   * mass delivered: median level of the stable readings after the tap minus
//     the median level before it (crane swing averages out, touches excluded);
//   * average rate = mass delivered / tap duration   (the definition of an average
//     flow rate, not a regression slope);
//   * a smoothed rate curve: centred 30 s Theil–Sen slope.

import { robustSlope, hingeOnset, hingeStop, median, lowerBound } from './stats.js';

export const OFFLINE_DEFAULTS = {
  onKgMin: 150,
  mergeGapSec: 10,
  minSegSec: 20,
  minSegKg: 150,
  halfWin: 15,
  levelWin: 20,
};

const ACCEPTED = new Set([0, 1, 2]);

function screenPre(meas) {
  // 'pre' readings (before the online filter ran) get a simple robust screen:
  // drop readings far below the median of their +/-10 s neighbourhood.
  const out = [];
  const t = meas.map((r) => r.t), z = meas.map((r) => r.z);
  for (let i = 0; i < meas.length; i++) {
    const r = meas[i];
    if (!ACCEPTED.has(r.f)) continue;
    if (r.f === 0) {
      const a = lowerBound(t, r.t - 10), b = lowerBound(t, r.t + 10);
      const m = median(z.slice(a, b));
      if (r.z < m - 250) continue;
    }
    out.push(r);
  }
  return out;
}

export function analyseSession(sess, opts = {}) {
  const o = { ...OFFLINE_DEFAULTS, ...opts };
  const cfg = sess.config || {};
  const target = cfg.targetKgMin ?? 600, tol = cfg.tolPct ?? 10;
  const hi = target * (1 + tol / 100), lo = target * (1 - tol / 100);
  const sigmaFloor = (cfg.stepKg ?? 50) / Math.sqrt(12);
  const acc = screenPre(sess.meas || []);
  const t = acc.map((r) => r.t), z = acc.map((r) => r.z);
  const n = t.length;
  const result = { segments: [], totals: null, smooth: { t: [], rate: [], ci: [] }, coverage: null };
  const nMeas = (sess.meas || []).length;
  const dur = sess.duration || (nMeas ? sess.meas[nMeas - 1].t : 0);
  result.coverage = dur > 0 ? Math.min(1, (nMeas * (cfg.binSec ?? 0.5)) / dur) : null;
  if (n < 10) return finish(result, sess, hi, lo);

  // smoothed rate curve
  for (let tc = t[0] + 2; tc <= t[n - 1] - 2; tc += 1) {
    const i0 = lowerBound(t, tc - o.halfWin), i1 = lowerBound(t, tc + o.halfWin);
    if (i1 - i0 < 10) continue;
    const f = robustSlope(t, z, i0, i1, { sigmaFloor });
    if (!f) continue;
    result.smooth.t.push(tc);
    result.smooth.rate.push(f.slope * 60);
    result.smooth.ci.push(1.645 * f.se * 60);
  }
  // flow segments from the smoothed rate
  const S = result.smooth;
  let runs = [];
  for (let i = 0, s = -1; i <= S.t.length; i++) {
    const on = i < S.t.length && S.rate[i] >= o.onKgMin;
    if (on && s < 0) s = i;
    if (!on && s >= 0) { runs.push([S.t[s], S.t[i - 1]]); s = -1; }
  }
  for (let j = 0; j < runs.length - 1;) {
    if (runs[j + 1][0] - runs[j][1] <= o.mergeGapSec) runs.splice(j, 2, [runs[j][0], runs[j + 1][1]]);
    else j++;
  }
  // fall back to the live segments if the smoothed curve found none
  if (!runs.length && sess.segments?.length) runs = sess.segments.map((s) => [s.onset, s.end ?? t[n - 1]]);

  const touches = (sess.events || []).filter((e) => e.type === 'touch-end');
  for (const [rs, re] of runs) {
    // refine the start: flat-then-rising change point
    let a0 = lowerBound(t, rs - 45), a1 = lowerBound(t, Math.min(re, rs + 40));
    const hOn = hingeOnset(t.slice(a0, a1), z.slice(a0, a1), { minTail: 3 });
    let onset = hOn ? hOn.tau : rs - o.halfWin / 2;
    // refine the end: rising-then-flat change point
    a0 = lowerBound(t, Math.max(onset + 5, re - 40)); a1 = lowerBound(t, re + 45);
    const hOff = hingeStop(t.slice(a0, a1), z.slice(a0, a1), { minHead: 3 });
    let end = hOff ? hOff.tau : re + o.halfWin / 2;
    onset = Math.max(t[0], onset); end = Math.min(t[n - 1], Math.max(end, onset + 1));
    const dt = end - onset;
    // levels before / after
    const lvl = (from, to) => {
      const i0 = lowerBound(t, from), i1 = lowerBound(t, to);
      return i1 - i0 >= 6 ? { v: median(z.slice(i0, i1)), n: i1 - i0 } : null;
    };
    const before = lvl(onset - o.levelWin, onset - 0.5);
    const after = lvl(end + 0.5, end + o.levelWin);
    const levelBefore = before ? before.v : hOn ? hOn.a : z[lowerBound(t, onset)];
    let levelAfter, openEnd = false;
    if (after) levelAfter = after.v;
    else {
      openEnd = true;
      const i0 = lowerBound(t, end - 5);
      levelAfter = median(z.slice(i0, lowerBound(t, end + 0.01) || n));
    }
    const dm = levelAfter - levelBefore;
    if (dt < o.minSegSec || dm < o.minSegKg) continue;
    const avg = (dm / dt) * 60;
    // uncertainty: level medians (n_eff ~ n/3 for correlated readings) and +/-1 s timing at each end
    const sig = Math.max(sigmaFloor, sess.noiseSigma || 30);
    const seLvl = (k) => 1.2533 * sig / Math.sqrt(Math.max(1, (k || 6) / 3));
    const seDm = Math.hypot(seLvl(before?.n), seLvl(after?.n));
    const seAvg = Math.hypot((seDm / dt) * 60, (avg * Math.SQRT2) / dt);
    // time spent above / within / below the band (smoothed rate)
    let nHi = 0, nLo = 0, nOk = 0, peak60 = null;
    for (let i = 0; i < S.t.length; i++) {
      if (S.t[i] < onset + o.halfWin || S.t[i] > end - o.halfWin) continue;
      if (S.rate[i] > hi) nHi++; else if (S.rate[i] < lo) nLo++; else nOk++;
    }
    for (let tc = onset + 60; tc <= end + 0.01; tc += 5) {
      const i0 = lowerBound(t, tc - 60), i1 = lowerBound(t, tc);
      const f = i1 - i0 >= 20 ? robustSlope(t, z, i0, i1, { sigmaFloor }) : null;
      if (f && (peak60 == null || f.slope * 60 > peak60)) peak60 = f.slope * 60;
    }
    const nTot = nHi + nLo + nOk;
    const segTouches = touches.filter((e) => e.t >= onset && e.t <= end + 5);
    result.segments.push({
      onset: +onset.toFixed(1), end: +end.toFixed(1), duration: +dt.toFixed(1),
      levelBefore: Math.round(levelBefore), levelAfter: Math.round(levelAfter),
      massKg: Math.round(dm), avgKgMin: Math.round(avg), ciKgMin: Math.round(1.645 * seAvg),
      peak60KgMin: peak60 == null ? null : Math.round(peak60),
      pctFast: nTot ? Math.round((100 * nHi) / nTot) : null,
      pctOk: nTot ? Math.round((100 * nOk) / nTot) : null,
      pctSlow: nTot ? Math.round((100 * nLo) / nTot) : null,
      touches: segTouches.length,
      touchSec: +segTouches.reduce((a, e) => a + (e.dur || 0), 0).toFixed(1),
      openEnd,
      partialStart: !before && !!sess.partialStart,
      verdict: avg > hi ? 'fast' : avg < lo ? 'slow' : 'ok',
    });
  }
  return finish(result, sess, hi, lo);
}

function finish(result, sess, hi, lo) {
  const segs = result.segments;
  const mass = segs.reduce((a, s) => a + s.massKg, 0);
  const time = segs.reduce((a, s) => a + s.duration, 0);
  const avg = time > 0 ? (mass / time) * 60 : null;
  result.totals = {
    taps: segs.length,
    massKg: Math.round(mass),
    flowSec: +time.toFixed(1),
    avgKgMin: avg == null ? null : Math.round(avg),
    verdict: avg == null ? null : avg > hi ? 'fast' : avg < lo ? 'slow' : 'ok',
    touches: sess.touchCount ?? 0,
    noiseSigma: sess.noiseSigma ?? null,
    coverage: result.coverage,
  };
  return result;
}
