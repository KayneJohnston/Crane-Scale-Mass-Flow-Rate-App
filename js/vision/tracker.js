// Temporal consistency for display readings.
//
// Frames arrive ~10 times a second and the weight changes slowly, so each new
// frame is judged against what the recent readings predict:
//
//   prediction = median of the last few accepted readings + current trend
//   band       = +/- 4 x the recent frame-to-frame jitter (2..10 display steps)
//
//   * a clear reading inside the band ............ accepted
//   * a clear reading outside the band (20050 -> 10050) is not believed on one
//     frame (and never rewritten either): it must repeat on several consecutive
//     frames. Drops (the crucible touching the cell) or returns to a recently
//     seen level need 3 frames; a jump above anything recently seen - physically
//     impossible for metal pouring in - must persist for 3 s.
//   * a frame the reader could not decide on its own (e.g. "7" vs "9", a faint
//     segment) is accepted as the value inside the band that its digits fit
//     almost as well as their best reading - the prior resolves the ambiguity.
//     Not while a jump is pending, when the display may have changed.
//
// The reader supplies, per digit position, the cost of reading that glyph as
// each digit 0-9 (sevenseg.js "lattice"); costs are L1 distances between the
// measured segment fills and the digit templates (~0.3 for a clean match, ~1 per
// mismatching segment).

import { median, robustSlope } from '../analysis/stats.js';

export const TRACK_DEFAULTS = {
  levelFrames: 7,          // readings in the median "current level"
  historySec: 10,
  staleSec: 8,             // nothing accepted for this long: start afresh
  lockFrames: 2,           // consistent frames needed to lock on at the start
  relockFrames: 3,         // consistent frames needed to believe a jump
  relockWindowSec: 1.5,    // max gap between frames counted towards a jump
  implausibleSec: 3,       // an upward jump above anything recent must persist this long
  maxDropKg: 5000,         // larger drops are treated like implausible jumps
  minBandSteps: 3,
  maxBandSteps: 10,
  maxRateKgS: 50,          // physical limit used to widen the band after gaps
  rescueMaxDelta: 1.2,     // an undecided frame is resolved if its digits fit this well
  rescueMaxDigitCost: 2.0, // ... and no single digit fits worse than this
  rescueMinMargin: 0.6,    // ... and clearly better than any other value in the band
  rescueMaxBandSteps: 4,   // only when readings are steady (not during a bouncing touch)
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * Best reading of a frame near the prediction, given its per-digit costs.
 * Values are scored over a neighbourhood wider than the band, so a value just
 * outside the band that fits the digits better is noticed (the returned best is
 * then flagged !inBand and must not be used to rescue the frame).
 */
export function bestInBand(lattice, pred, cfg) {
  if (!lattice || !pred) return null;
  const { costs, n } = lattice;
  const mult = cfg.multiplier || 1, step = cfg.stepKg || 50;
  let bestCost = 0;
  for (const c of costs) bestCost += Math.min(...c);
  const wide = pred.band + Math.max(500, 2 * pred.band);
  let best = null, second = null;
  const lo = Math.ceil((pred.value - wide) / step) * step;
  for (let v = lo; v <= pred.value + wide; v += step) {
    if (v < cfg.minKg || v > cfg.maxKg) continue;
    const ds = String(Math.round(v / mult));
    if (ds.length !== n) continue;
    let cost = 0, mx = 0;
    for (let i = 0; i < n; i++) {
      const ci = costs[i][ds.charCodeAt(i) - 48];
      cost += ci;
      if (ci > mx) mx = ci;
    }
    const score = cost + (0.002 * Math.abs(v - pred.value)) / step; // ties -> nearest the prediction
    const cand = { v, cost, score, maxDigitCost: mx, inBand: Math.abs(v - pred.value) <= pred.band };
    if (!best || score < best.score) { second = best; best = cand; } else if (!second || score < second.score) second = cand;
  }
  if (best) {
    best.excess = best.cost - bestCost;
    // how much better than the next most plausible value (14600 vs 14800 must not be guessed)
    best.margin = second ? second.cost - best.cost : Infinity;
  }
  return best;
}

export class DisplayTracker {
  constructor() { this.reset(); }

  reset() { this.hist = []; this.pending = null; }

  /** Predicted display value at time t (null before lock-on or after a long gap). */
  predict(t, cfg = {}) {
    const c = { ...TRACK_DEFAULTS, ...cfg };
    const H = this.hist;
    if (!H.length) return null;
    const last = H[H.length - 1];
    if (t - last.t > c.staleSec) { this.hist = []; return null; }
    const recent = H.slice(-c.levelFrames);
    const level = median(recent.map((h) => h.v));
    const tl = recent.reduce((a, h) => a + h.t, 0) / recent.length;
    let slope = 0;
    if (H.length >= 12 && last.t - H[0].t >= 3) {
      const f = robustSlope(H.map((h) => h.t), H.map((h) => h.v), 0, H.length, { sigmaFloor: 0 });
      if (f) slope = clamp(f.slope, -c.maxRateKgS, c.maxRateKgS);
    }
    const value = level + slope * (t - tl);
    const res = H.slice(-30).map((h) => Math.abs(h.v - (level + slope * (h.t - tl))));
    const sig = 1.4826 * median(res);
    const step = c.stepKg || 50;
    const gap = Math.max(0, t - last.t - 1);
    const band = clamp(4 * sig, c.minBandSteps * step, c.maxBandSteps * step) + c.maxRateKgS * gap;
    let high = -Infinity;
    for (const h of H) if (h.v > high) high = h.v;
    return { value, band, level, slope, high };
  }

  accept(t, v, c) {
    this.hist.push({ t, v });
    while (this.hist.length && this.hist[0].t < t - c.historySec) this.hist.shift();
  }

  /** Count a reading towards a pending jump (or the initial lock); re-lock when convincing. */
  confirm(t, v, c, needFrames, needSec, kind) {
    const step = c.stepKg || 50;
    const tol = Math.max(3 * step, 150);
    const P = this.pending;
    if (P && Math.abs(v - P.v) <= tol && t - P.tLast <= c.relockWindowSec) {
      P.n++; P.tLast = t; P.vals.push({ t, v });
      P.v = median(P.vals.map((x) => x.v));
    } else this.pending = { v, n: 1, t0: t, tLast: t, vals: [{ t, v }], kind };
    const Q = this.pending;
    if (Q.n >= needFrames && Q.tLast - Q.t0 >= needSec) {
      this.hist = Q.vals.slice();
      this.pending = null;
      return { value: v, how: kind === 'lock' ? 'locked' : 'jump-accepted' };
    }
    return { value: null, how: kind === 'lock' ? 'locking' : 'jump-pending', pending: Q.n, need: needFrames };
  }

  /**
   * Decide what this frame shows.
   * attempts: reader results for this frame ({ok, value, lattice}); pred: from predict().
   * Returns {value|null, how, pred, near}.
   */
  decide(t, attempts, cfg = {}, pred = undefined) {
    const c = { ...TRACK_DEFAULTS, ...cfg };
    const p = pred === undefined ? this.predict(t, c) : pred;
    const strictR = attempts.find((r) => r.ok) || null;
    const strict = strictR ? strictR.value : null;
    if (!p) {
      if (strict == null) return { value: null, how: 'unread', pred: null };
      return { ...this.confirm(t, strict, c, c.lockFrames, 0, 'lock'), pred: null };
    }
    if (strict != null && Math.abs(strict - p.value) <= p.band) {
      this.pending = null;
      this.accept(t, strict, c);
      return { value: strict, how: 'ok', pred: p, from: strictR };
    }
    // the best in-band interpretation of this frame's digits
    let near = null, nearR = null;
    for (const r of attempts) {
      const nb = bestInBand(r.lattice, p, c);
      if (nb && (!near || nb.excess < near.excess)) { near = nb; nearR = r; }
    }
    if (strict != null) {
      // a clear reading away from the prediction: a genuine change only if it repeats
      const fast = (strict < p.value && p.value - strict <= c.maxDropKg) || strict <= p.high + p.band;
      const j = this.confirm(t, strict, c, c.relockFrames, fast ? 0 : c.implausibleSec, 'jump');
      return { ...j, pred: p, near, from: j.value != null ? strictR : undefined };
    }
    const jumpPending = this.pending && t - this.pending.tLast <= c.relockWindowSec;
    const steady = p.band <= c.rescueMaxBandSteps * (c.stepKg || 50);
    if (!jumpPending && steady && near && near.inBand && near.excess <= c.rescueMaxDelta && near.maxDigitCost <= c.rescueMaxDigitCost && near.margin >= c.rescueMinMargin) {
      this.accept(t, near.v, c);
      return { value: near.v, how: 'prior', pred: p, near, from: nearR };
    }
    return { value: null, how: 'unread', pred: p, near };
  }
}
