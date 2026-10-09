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
//     impossible for metal pouring in - or a drop of more than 5 t must persist
//     for 3 s.
//   * a frame the reader could not decide on its own (e.g. "7" vs "9", a faint
//     segment) is accepted as the value inside the band that its digits fit
//     almost as well as their best reading - the prior resolves the ambiguity.
//     Not while a jump is pending, when the display may have changed, nor after
//     20 s of such guesses without one clear reading.
//   * a clear reading that is the expected value with a digit lost or added
//     (17000 read as 1700 or 7000 when a "0" or the "1" drowns in the glow) is
//     refused however often it repeats - also for a minute after the readings
//     stopped, so it cannot take over when the history is started afresh.
//
// While the readings stop (the reader can't make out the digits), the band of
// that prediction must grow at the fastest rate metal could pour. The tap
// engine knows the actual rate: given its expectation (TapEngine.expectation),
// the prediction comes from there instead - also once the history is stale -
// so the prior keeps resolving unclear frames through a long spell of them.
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
  implausibleSec: 3,       // an upward jump above anything recent must persist this long,
  maxDropKg: 5000,         // ... and so must a larger drop
  slipSec: 60,             // how long the last level is remembered for refusing a digit slip
  minBandSteps: 3,
  maxBandSteps: 10,
  maxRateKgS: 50,          // physical limit used to widen the band after gaps
  rescueMaxDelta: 1.2,     // an undecided frame is resolved if its digits fit this well
  rescueMaxDigitCost: 2.0, // ... and no single digit fits worse than this
  rescueMinMargin: 0.6,    // ... and clearly better than any other value it could be
  rescueMaxBandSteps: 4,   // only when readings are steady (not during a bouncing touch)
  rescueMaxSec: 20,        // ... and a clear reading was accepted this recently
  touchKg: 2000,           // how far a touch can pull the reading down unseen (see bestInBand)
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

// b is a with one character added
function oneMore(a, b) {
  if (b.length !== a.length + 1) return false;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return a.slice(i) === b.slice(i + 1);
}

/**
 * Is reading v a value in lo..hi with one digit lost or one added? (17000 -> 1700,
 * 7000; 9950 -> 19950.) A genuine change of the weight almost never lands there.
 */
export function digitSlip(v, lo, hi, cfg) {
  const mult = cfg.multiplier || 1, step = cfg.stepKg || 50;
  const s = String(Math.round(v / mult));
  for (let x = Math.max(step, Math.ceil(lo / step) * step); x <= hi; x += step) {
    const xs = String(Math.round(x / mult));
    if (oneMore(xs, s) || oneMore(s, xs)) return true;
  }
  return false;
}

/** May an unclear frame be read as nb (from bestInBand) with this prediction? */
export function canRescue(nb, pred, cfg) {
  if (!nb || !pred || !nb.inBand) return false;
  // Only in a narrow band: the wider it is (a bouncing touch, a long spell without
  // readings), the likelier a misread digit lands on a value inside it.
  return pred.band <= cfg.rescueMaxBandSteps * (cfg.stepKg || 50) && nb.excess <= cfg.rescueMaxDelta &&
    nb.maxDigitCost <= cfg.rescueMaxDigitCost && nb.margin >= cfg.rescueMinMargin;
}

// prediction from the tap engine's expectation {lo, hi, level, high}
function fromExpectation(e, c) {
  if (!e || !(e.hi >= e.lo)) return null;
  const band = Math.max(c.minBandSteps * (c.stepKg || 50), (e.hi - e.lo) / 2);
  return { value: (e.lo + e.hi) / 2, band, level: e.level ?? (e.lo + e.hi) / 2, slope: 0, high: e.high ?? e.hi, external: true };
}

/**
 * Best reading of a frame near the prediction, given its per-digit costs.
 * Values are scored over a neighbourhood wider than the band, so a value just
 * outside the band that fits the digits better is noticed (the returned best is
 * then flagged !inBand and must not be used to rescue the frame). When the
 * prediction comes from the tap engine (no recent readings), a touch may have
 * pulled the reading down meanwhile: the neighbourhood then reaches touchKg
 * below the band, so a frame is not "corrected" up to the expected weight while
 * the crucible rests on the cell unseen.
 */
export function bestInBand(lattice, pred, cfg) {
  if (!lattice || !pred) return null;
  const { costs, n } = lattice;
  const mult = cfg.multiplier || 1, step = cfg.stepKg || 50;
  let bestCost = 0;
  for (const c of costs) bestCost += Math.min(...c);
  const wide = pred.band + Math.max(500, 2 * pred.band);
  let best = null, second = null;
  const below = pred.external ? Math.max(wide, pred.band + (cfg.touchKg ?? 0)) : wide;
  const lo = Math.ceil((pred.value - below) / step) * step;
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

  reset() { this.hist = []; this.pending = null; this.last = null; this.peak = null; this.lastClear = -Infinity; }

  /**
   * Predicted display value at time t: {value, band, high}, null before lock-on or
   * after a long gap. `expect` ({lo, hi, level, high} in kg, from the tap engine) stands
   * in when the recent readings can't say more ({..., external: true}).
   */
  predict(t, cfg = {}, expect = null) {
    const c = { ...TRACK_DEFAULTS, ...cfg };
    const own = this.ownPredict(t, c);
    const ext = fromExpectation(expect, c);
    if (!ext) return own;
    if (!own) return ext;
    // Without readings for a while, the band has grown at the fastest rate metal could
    // pour; the engine knows the real rate. (Not when the two disagree: during a touch
    // the readings follow the scale down, the engine does not.)
    const jitterSteady = own.jitter <= c.rescueMaxBandSteps * (c.stepKg || 50);
    if (own.gap > 0 && jitterSteady && ext.band < own.band && own.level >= expect.lo - own.jitter && own.level <= expect.hi + own.jitter) {
      return { ...ext, high: Math.max(own.high, ext.high) };
    }
    return own;
  }

  ownPredict(t, c) {
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
    const jitter = clamp(4 * sig, c.minBandSteps * step, c.maxBandSteps * step);
    const gap = c.maxRateKgS * Math.max(0, t - last.t - 1);
    let high = -Infinity;
    for (const h of H) if (h.v > high) high = h.v;
    return { value, band: jitter + gap, level, slope, high, jitter, gap };
  }

  accept(t, v, c) {
    this.hist.push({ t, v });
    this.remember(t, v, c);
    while (this.hist.length && this.hist[0].t < t - c.historySec) this.hist.shift();
  }

  // the last accepted value, and the highest one of the last slipSec (the weight comes
  // back to it after a touch)
  remember(t, v, c) {
    this.last = { t, v };
    if (!this.peak || v >= this.peak.v || t - this.peak.t > c.slipSec) this.peak = { t, v };
  }

  /**
   * Is v the expected value (or, for slipSec after the last accepted reading, a value
   * the reading could have reached since: up at the fastest pouring rate, down by a
   * touch) with a digit lost or added?
   */
  isSlip(t, v, p, c) {
    if (p && Math.abs(v - p.value) <= p.band) return false;
    if (p && digitSlip(v, p.value - p.band, p.value + p.band, c)) return true;
    const L = this.last;
    if (!L || t - L.t > c.slipSec) return false;
    const step = c.stepKg || 50;
    const top = t - this.peak.t <= c.slipSec ? Math.max(L.v, this.peak.v) : L.v;
    return digitSlip(v, L.v - c.touchKg, top + c.maxRateKgS * (t - L.t) + c.minBandSteps * step, c);
  }

  /** Would an unclear frame be resolved as nb (from bestInBand) now? */
  willRescue(t, nb, p, c) {
    if (this.pending && t - this.pending.tLast <= c.relockWindowSec) return false; // a jump is being checked
    // (a long run of guesses without one clear reading may have drifted off)
    return t - this.lastClear <= c.rescueMaxSec && canRescue(nb, p, c);
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
      this.remember(t, v, c);
      this.lastClear = t;
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
    // clear readings, those in the band first; a digit slip counts as no reading
    const oks = attempts.filter((r) => r.ok);
    const sound = oks.filter((r) => !this.isSlip(t, r.value, p, c));
    const strictR = (p && sound.find((r) => Math.abs(r.value - p.value) <= p.band)) || sound[0] || null;
    const strict = strictR ? strictR.value : null;
    const nothing = sound.length < oks.length ? 'digit-slip' : 'unread';
    if (!p) {
      if (strict == null) return { value: null, how: nothing, pred: null };
      return { ...this.confirm(t, strict, c, c.lockFrames, 0, 'lock'), pred: null };
    }
    if (strict != null && Math.abs(strict - p.value) <= p.band) {
      this.pending = null;
      this.accept(t, strict, c);
      this.lastClear = t;
      return { value: strict, how: 'ok', pred: p, from: strictR };
    }
    // the best in-band interpretation of this frame's digits
    let near = null, nearR = null;
    for (const r of attempts) {
      const nb = bestInBand(r.lattice, p, c);
      if (nb && (!near || nb.excess < near.excess)) { near = nb; nearR = r; }
    }
    if (strict != null) {
      // A clear reading away from the prediction: a genuine change only if it repeats.
      // Quickly for a drop (the crucible touching the cell) or a return to a level just
      // seen; a rise above anything recent - impossible for pouring metal - or a drop of
      // more than maxDropKg must persist for implausibleSec.
      const drop = p.value - strict;
      const fast = drop > 0 ? drop <= c.maxDropKg : strict <= p.high + p.band;
      const j = this.confirm(t, strict, c, c.relockFrames, fast ? 0 : c.implausibleSec, 'jump');
      return { ...j, pred: p, near, from: j.value != null ? strictR : undefined };
    }
    if (this.willRescue(t, near, p, c)) {
      this.accept(t, near.v, c);
      return { value: near.v, how: 'prior', pred: p, near, from: nearR };
    }
    return { value: null, how: nothing, pred: p, near };
  }
}
