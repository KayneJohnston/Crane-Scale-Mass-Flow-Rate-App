// Post-session analysis of a saved session (uses all the data, not just the past).
//
// Per tap ("flow segment"):
//   * start / end: change-point (hinge) fits on the accepted readings;
//   * mass delivered: median level of the stable readings after the tap minus
//     the median level before it (crane swing averages out, touches excluded);
//   * average rate = mass delivered / tap duration   (the definition of an average
//     flow rate, not a regression slope);
//   * the rate through the tap: the live filter's model run forward and then
//     backward over the tap's readings (two-pass smoother), so each moment's rate
//     uses the readings after it as well as before - no lag, about half the error
//     of the live estimate - from the level before the tap to the level after it.
//     Between taps: centred 30 s Theil–Sen slope.

import { robustSlope, hingeOnset, hingeStop, median, lowerBound } from './stats.js';
import { smoothRate, rateVarToS } from './kalman.js';

// bump when the analysis changes, so saved taps are analysed again
export const ANALYSIS_VERSION = 4;

export const OFFLINE_DEFAULTS = {
  onKgMin: 150,
  mergeGapSec: 10,
  minRunSec: 5,        // shorter blips of the 30 s rate are noise, not taps
  minSegSec: 20,
  minSegKg: 150,
  halfWin: 15,
  levelWin: 20,
  edgeSec: 5,          // time in band: leave out the first and last seconds of a tap
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
  const result = { version: ANALYSIS_VERSION, segments: [], totals: null, smooth: { t: [], rate: [], ci: [] }, coverage: null };
  const nMeas = (sess.meas || []).length;
  const dur = sess.duration || (nMeas ? sess.meas[nMeas - 1].t : 0);
  result.coverage = dur > 0 ? Math.min(1, (nMeas * (cfg.binSec ?? 0.5)) / dur) : null;
  if (n < 10) return finish(result, sess, hi, lo);

  // centred 30 s slopes (only within [a, b]): find the taps, and the rate between them.
  // Only from readings spanning at least half the window: a few seconds of readings at
  // the edge of a gap (display out of view) give a slope that is mostly noise.
  const slope30 = (tc, a = -Infinity, b = Infinity) => {
    const i0 = lowerBound(t, Math.max(a, tc - o.halfWin)), i1 = lowerBound(t, Math.min(b, tc + o.halfWin));
    return i1 - i0 >= 10 && t[i1 - 1] - t[i0] >= o.halfWin ? robustSlope(t, z, i0, i1, { sigmaFloor }) : null;
  };
  const grid = [];
  for (let tc = t[0] + 2; tc <= t[n - 1] - 2; tc += 1) grid.push(tc);
  const S = { t: [], rate: [] };
  for (const tc of grid) {
    const f = slope30(tc);
    if (f) { S.t.push(tc); S.rate.push(f.slope * 60); }
  }
  // flow segments from the 30 s rate
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
  // A gap in the readings (display out of view) inside a run splits it, unless the
  // weight rose across the gap as if the flow had carried on: the crane may have
  // moved to the next pot meanwhile.
  const split = [];
  for (const [rs, re] of runs) {
    let a = rs;
    for (let k = lowerBound(t, rs); k < n - 1 && t[k + 1] <= re; k++) {
      const g0 = t[k], g1 = t[k + 1];
      if (g1 - g0 <= o.mergeGapSec) continue;
      const before = median(z.slice(lowerBound(t, g0 - 5), k + 1));
      const after = median(z.slice(k + 1, lowerBound(t, g1 + 5)));
      const f = slope30(g0 - o.halfWin);
      if (after - before < 0.5 * Math.max(0, f ? f.slope : 0) * (g1 - g0)) { split.push([a, g0]); a = g1; }
    }
    split.push([a, re]);
  }
  // A lone blip is not a tap: e.g. a few noisy readings at the edge of a gap in the
  // data (display out of view while the crane moves to the next pot).
  runs = split.filter(([a, b]) => b - a >= o.minRunSec);
  // fall back to the live segments if the smoothed curve found none
  if (!runs.length && sess.segments?.length) runs = sess.segments.map((s) => [s.onset, s.end ?? t[n - 1]]);

  const touches = (sess.events || []).filter((e) => e.type === 'touch-end');
  const Sq = rateVarToS(cfg.rateVar ?? 100);
  const curves = [];
  for (let k = 0; k < runs.length; k++) {
    const [rs, re] = runs[k];
    // (never reaching into the previous or the next tap)
    const prevEnd = k > 0 ? runs[k - 1][1] : -Infinity, nextStart = k + 1 < runs.length ? runs[k + 1][0] : Infinity;
    // refine the start: flat-then-rising change point
    let a0 = lowerBound(t, Math.max(prevEnd, rs - 45)), a1 = lowerBound(t, Math.min(re, rs + 40));
    const hOn = hingeOnset(t.slice(a0, a1), z.slice(a0, a1), { minTail: 3 });
    let onset = hOn ? hOn.tau : rs - o.halfWin / 2;
    // refine the end: rising-then-flat change point
    a0 = lowerBound(t, Math.max(onset + 5, re - 40)); a1 = lowerBound(t, Math.min(nextStart, re + 45));
    const hOff = hingeStop(t.slice(a0, a1), z.slice(a0, a1), { minHead: 3 });
    let end = hOff ? hOff.tau : re + o.halfWin / 2;
    onset = Math.max(t[0], onset); end = Math.min(t[n - 1], Math.max(end, onset + 1));
    const dt = end - onset;
    // levels before / after
    const lvl = (from, to) => {
      const i0 = lowerBound(t, from), i1 = lowerBound(t, to);
      return i1 - i0 >= 6 ? { v: median(z.slice(i0, i1)), n: i1 - i0 } : null;
    };
    let before = lvl(Math.max(prevEnd, onset - o.levelWin), onset - 0.5);
    // The display was out of view shortly before the tap (e.g. the crane moving to this
    // pot): the level the crucible was left at before that gap. Only this tap can have
    // added metal since, whether it started during the gap or after it.
    for (let j = Math.min(n - 1, lowerBound(t, onset)); j > 0 && t[j] >= onset - o.levelWin; j--) {
      if (t[j] - t[j - 1] > o.mergeGapSec) { before = lvl(Math.max(prevEnd, t[j - 1] - o.levelWin), t[j - 1] + 0.01) || { v: z[j - 1], n: 1 }; break; }
    }
    const after = lvl(end + 0.5, Math.min(nextStart, end + o.levelWin));
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
    // the rate through the tap, from the level before to the level after
    const R = sig * sig;
    const anchor = (lvl) => (lvl ? seLvl(lvl.n) ** 2 : R);
    const curve = tapCurve(acc, onset, end, levelBefore, anchor(before), levelAfter, openEnd ? R : anchor(after), avg, R, Sq);
    if (curve) curves.push(curve);
    // time spent above / within / below the band
    let nHi = 0, nLo = 0, nOk = 0, peak60 = null;
    for (const tc of grid) {
      if (tc < onset + o.edgeSec || tc > end - o.edgeSec) continue;
      const r = curve ? curveAt(curve, tc).rate : slope30(tc)?.slope * 60;
      if (r == null || !Number.isFinite(r)) continue;
      if (r > hi) nHi++; else if (r < lo) nLo++; else nOk++;
    }
    // highest 60 s average rate: what the smoothed weight gained in the best minute
    for (let tc = onset + 60; tc <= end + 0.01; tc += curve ? 1 : 5) {
      let r = null;
      if (curve) r = curveAt(curve, tc).m - curveAt(curve, tc - 60).m;
      else {
        const i0 = lowerBound(t, tc - 60), i1 = lowerBound(t, tc);
        const f = i1 - i0 >= 20 ? robustSlope(t, z, i0, i1, { sigmaFloor }) : null;
        if (f) r = f.slope * 60;
      }
      if (r != null && (peak60 == null || r > peak60)) peak60 = r;
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
  // the final curve: the smoothed rate inside the taps, 30 s slopes between them that
  // don't reach into a tap (no ramp drawn before a tap starts or after it ends)
  for (const tc of grid) {
    const c = curves.find((k) => tc >= k.t0 && tc <= k.t1);
    if (c) {
      const v = curveAt(c, tc);
      result.smooth.t.push(tc); result.smooth.rate.push(v.rate); result.smooth.ci.push(v.ci);
      continue;
    }
    let a = -Infinity, b = Infinity;
    for (const k of curves) { if (k.t1 < tc) a = Math.max(a, k.t1); if (k.t0 > tc) b = Math.min(b, k.t0); }
    const f = slope30(tc, a, b);
    if (!f) continue;
    result.smooth.t.push(tc); result.smooth.rate.push(f.slope * 60); result.smooth.ci.push(1.645 * f.se * 60);
  }
  return finish(result, sess, hi, lo);
}

// Two-pass smoother over the readings of one tap, pinned to the level before it at
// the start and the level after it at the end (so the curve agrees with the tap's
// average rate). Readings the live filter down-weighted keep their lower weight.
function tapCurve(acc, onset, end, before, varBefore, after, varAfter, avgKgMin, R, Sq) {
  const ts = [onset], zs = [before], rs = [varBefore];
  for (const r of acc) {
    if (r.t <= onset || r.t >= end) continue;
    ts.push(r.t); zs.push(r.z); rs.push(R / (r.w || 1));
  }
  if (ts.length < 11) return null;
  ts.push(end); zs.push(after); rs.push(varAfter);
  const q0 = Math.max(0, avgKgMin) / 60;
  const sm = smoothRate(Sq, ts, zs, rs, { t: onset, m: before, q: q0, Pmm: 1e6, Pqq: q0 * q0 + 1 });
  return { t0: onset, t1: end, ts, q: sm.map((x) => x.q), sdq: sm.map((x) => x.sdq), m: sm.map((x) => x.m) };
}

// the curve at time tc (linear between readings): rate and 90% interval in kg/min, mass in kg
function curveAt(c, tc) {
  const i = Math.min(c.ts.length - 1, Math.max(1, lowerBound(c.ts, tc)));
  const t0 = c.ts[i - 1], t1 = c.ts[i];
  const u = t1 > t0 ? Math.min(1, Math.max(0, (tc - t0) / (t1 - t0))) : 1;
  const lin = (a) => a[i - 1] + u * (a[i] - a[i - 1]);
  return { rate: lin(c.q) * 60, ci: 1.645 * lin(c.sdq) * 60, m: lin(c.m) };
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
