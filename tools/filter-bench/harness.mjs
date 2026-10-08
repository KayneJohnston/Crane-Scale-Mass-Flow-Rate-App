// Benchmark harness for live tap-rate estimators.
//
// Each simulated tap is run through the real engine (TapEngine) once. From it we keep
// every 0.5 s measurement in the order the engine processed it, whether the engine
// accepted it at that moment (touches and misreads rejected), the engine's own live
// rate, and how the engine initialised its filter at the start of the flow. Every
// candidate estimator then sees exactly that stream - the same cleaned readings and the
// same starting point - so the comparison is about the estimation method alone.

import { TapSimulator } from '../../js/analysis/sim.js';
import { TapEngine } from '../../js/analysis/engine.js';
import { RateKF } from '../../js/analysis/kalman.js';
import { secondDiffSigma } from '../../js/analysis/stats.js';
import { mulberry32 } from '../../js/vision/render7seg.js';

const W0 = Date.UTC(2026, 9, 7, 8, 0, 0);
export const TARGET = 600, HI = 660, LO = 540;

// Kinds of tap. "steps": the operator changes the vacuum abruptly (rate jumps).
export const SCENARIOS = {
  standard: { sim: {} },
  nearTarget: { sim: { rate0: 690, rateEnd: 595, wander: 30, tapMass: 3000 } },
  steps: { sim: { wander: 15, tapMass: 3300 }, profile: (tt) => (tt < 90 ? 760 : tt < 180 ? 560 : 660), steps: [90, 180] },
  noisy: { sim: { noise: 40, swingAmp: 60 } },
  clean: { sim: { noise: 5, swingAmp: 5 } },
  lowPower: { sim: { dropProb: 0.15 }, fps: 3 },
  messy: { sim: { misreadProb: 0.02, touches: 4, dropProb: 0.2 } },
};

// remember how the engine last (re)started its filter, so candidates can start alike
const kfInit = RateKF.prototype.init;
RateKF.prototype.init = function (...a) { this.lastInit = a; return kfInit.apply(this, a); };

function gauss(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// Replace the simulator's rate profile (keeps its display model, touches and swing).
function applyProfile(sim, profile) {
  const o = sim.o, dt = o.dt, rnd = mulberry32(o.seed * 101 + 3);
  const tStart = sim.tapStart;
  const ms = [], rs = [];
  let m = sim.startMass, t = 0, tapped = 0, wander = 0, end = null;
  for (;;) {
    let rate = 0;
    if (t >= tStart && end == null) {
      const tt = t - tStart;
      wander += (-wander / o.wanderTau) * dt + o.wander * Math.sqrt((2 * dt) / o.wanderTau) * gauss(rnd);
      rate = Math.max(0, (profile(tt) + wander) * Math.min(1, tt / 3));
      tapped += (rate / 60) * dt;
      if (tapped >= o.tapMass) end = t;
    }
    ms.push(m); rs.push(rate);
    m += (rate / 60) * dt; t += dt;
    if (end != null && t > end + o.idleAfter) break;
  }
  sim.ms = ms; sim.rs = rs; sim.duration = t;
  sim.tapEnd = end; sim.tapList[0].end = end;
}

/** The simulated tap itself (deterministic: rebuilt from scenario and seed). */
export function buildSim(scenario, seed) {
  const sc = SCENARIOS[scenario];
  const sim = new TapSimulator({ seed, ...sc.sim });
  if (sc.profile) { applyProfile(sim, sc.profile); sim.profile = sc.profile; }
  sim.swingPeriod = realisticSwing(sim);
  return sim;
}

// A real load does not swing like a metronome: give each tap its own swing period
// (3-6 s), let the amplitude come and go and the period wander a little. (The plain
// simulator's swing is a constant 4.3 s sine, which would flatter a swing model.)
function realisticSwing(sim) {
  const o = sim.o, r = mulberry32(o.seed * 977 + 13);
  const P = 3 + 3 * r(), ph = 2 * Math.PI * r(), pa = 2 * Math.PI * r(), pf = 2 * Math.PI * r();
  const Ta = 60 + 80 * r(), Tf = 100 + 100 * r();
  sim.swing = (t) => o.swingAmp * (0.7 + 0.5 * Math.sin((2 * Math.PI * t) / Ta + pa)) *
    Math.sin((2 * Math.PI * t) / P + ph + 2 * Math.sin((2 * Math.PI * t) / Tf + pf));
  sim.displayValue = function (t) {
    const k = Math.floor(t * o.displayHz), td = k / o.displayHz;
    const rr = mulberry32((o.seed * 7919) ^ (k * 2654435761));
    const v = this.trueMass(td) + this.touchEffect(td) + o.noise * gauss(rr) + this.swing(td);
    return Math.round(v / o.stepKg) * o.stepKg;
  };
  return P;
}

/** One simulated tap of a scenario, run through the engine. */
export function makeCase(scenario, seed) {
  const sc = SCENARIOS[scenario];
  const sim = buildSim(scenario, seed);
  const fps = sc.fps ?? 10;
  const recs = [];
  let init = null;
  const eng = new TapEngine({}, {
    onEvent: (e) => {
      if (e.type === 'flow-start' && !init && eng.sess) {
        // the filter was started at the onset (then replayed): same start for everyone
        const S = eng.sess, [t0, m0, q0, Pmm, Pqq] = S.kf.lastInit;
        init = { T: S.T0 + t0, level: m0, rate: q0, Pmm, Pqq, detT: recs.length ? recs[recs.length - 1].T : S.T0 + t0 };
      }
    },
  });
  const orig = eng.kfProcess.bind(eng);
  eng.kfProcess = (rec) => {
    const S = eng.sess;
    orig(rec);
    recs.push({ T: S.T0 + rec.t, z: rec.z, ok: rec.flag === 'ok' || rec.flag === 'slow', qEng: S.kf.q, sdEng: Math.sqrt(S.kf.Pqq), replay: eng.replaying });
  };
  for (let t = 0; t < sim.duration + 5; t += 1 / fps) {
    const f = sim.frame(t);
    eng.pushFrame(t, W0 + t * 1000, f.value, f.conf);
  }
  // a second flow start would replay readings: keep each time once, in time order
  const seen = new Set();
  const stream = recs.filter((r) => (seen.has(r.T) ? false : seen.add(r.T))).sort((a, b) => a.T - b.T);
  // the noise level an online estimator knows at each reading (as the engine does it)
  const R = new Float64Array(stream.length);
  const at = [], az = [];
  let Rc = 40 * 40, nAcc = 0;
  const floor2 = (50 / Math.sqrt(12)) ** 2;
  stream.forEach((r, i) => {
    if (r.ok) {
      at.push(r.T); az.push(r.z); nAcc++;
      if (nAcc % 10 === 0) {
        let i0 = at.length - 1;
        while (i0 > 0 && at[i0 - 1] >= r.T - 60) i0--;
        const sig = secondDiffSigma(at, az, i0, at.length);
        if (sig != null) {
          const Rn = Math.min(300 * 300, Math.max(sig * sig, floor2));
          Rc = nAcc <= 10 ? Rn : 0.7 * Rc + 0.3 * Rn;
        }
      }
    }
    R[i] = Rc;
  });
  return { scenario, seed, sim, stream, R, init, steps: sc.steps || [] };
}

/**
 * Run an estimator factory over a case. est = make(ctx) with ctx = {init, R, stream}
 * must return {step(i, T, z, ok) -> {q, sd?}} (q, sd in kg/s).
 */
export function runEstimator(make, c) {
  if (!c.init) return null;
  const est = make({ init: c.init, R: c.R, stream: c.stream, seed: c.seed, sim: c.sim });
  const out = new Float64Array(c.stream.length).fill(NaN);
  const sd = new Float64Array(c.stream.length).fill(NaN);
  const t0 = performance.now();
  let n = 0;
  c.stream.forEach((r, i) => {
    if (r.T < c.init.T - 1e-9) return;
    const e = est.step(i, r.T, r.z, r.ok);
    out[i] = e.q; sd[i] = e.sd ?? NaN; n++;
  });
  return { q: out, sd, us: ((performance.now() - t0) * 1000) / Math.max(1, n) };
}

const band = (r) => (r > HI ? 1 : r < LO ? -1 : 0);
const HYST = TARGET * 0.01; // the app's status hysteresis (hystPct 1)

// the app's fast / ok / slow status with hysteresis, as a function of the shown rate
function statusSeq(rates) {
  let st = 0;
  return rates.map((q) => {
    if (st === 0) { if (q > HI + HYST) st = 1; else if (q < LO - HYST) st = -1; }
    else if (st === 1) { if (q < HI - HYST) st = q < LO - HYST ? -1 : 0; }
    else if (q > LO + HYST) st = q > HI + HYST ? 1 : 0;
    return st;
  });
}
const changes = (a) => a.reduce((n, x, i) => n + (i && x !== a[i - 1] ? 1 : 0), 0);

/** Errors of an estimator's output on one case (rates compared in kg/min). */
export function score(c, res) {
  const { sim, stream } = c;
  const e = [], e20 = [], cover = [], bands = [], shown = [], truth = [];
  let maxAbs = 0, jit = 0, nj = 0, prev = null, tA = null, tB = null;
  const t0 = Math.max(sim.tapStart + 20, c.init.detT);
  stream.forEach((r, i) => {
    const T = r.T, q = res.q[i];
    if (r.replay || !Number.isFinite(q)) return;
    if (T < t0 || T > sim.tapEnd - 3) return;
    shown.push(q * 60); truth.push(sim.trueRate(T));
    tA ??= T; tB = T;
    // how much the shown number moves from one reading to the next (kg/min)
    if (prev != null) { jit += (q * 60 - prev) ** 2; nj++; }
    prev = q * 60;
    if (sim.inTouch(T) || sim.inTouch(T - 1.5)) return;
    const tr = sim.trueRate(T);
    if (!(tr > 50)) return;
    const est = q * 60;
    const rel = (est - tr) / tr;
    e.push(rel);
    maxAbs = Math.max(maxAbs, Math.abs(rel));
    const avg20 = ((sim.trueMass(T) - sim.trueMass(T - 20)) / 20) * 60;
    e20.push((est - avg20) / avg20);
    if (Number.isFinite(res.sd[i])) cover.push(Math.abs(est - tr) <= 1.645 * res.sd[i] * 60 ? 1 : 0);
    bands.push(band(est) === band(tr) ? 1 : 0);
  });
  // step response: time after each step until the estimate is past the midpoint
  const resp = [];
  for (const s of c.steps) {
    const Ts = sim.tapStart + s;
    const before = c.sim.trueRate(Ts - 2), after = c.sim.trueRate(Ts + 5);
    const mid = (before + after) / 2, up = after > before;
    let found = null;
    stream.forEach((r, i) => {
      if (found != null || r.T < Ts || !Number.isFinite(res.q[i])) return;
      const est = res.q[i] * 60;
      if (up ? est >= mid : est <= mid) found = r.T - Ts;
    });
    if (found != null) resp.push(found);
  }
  // status changes per minute shown vs the true rate's own (same hysteresis)
  const mins = Math.max(1e-9, (tB - tA) / 60);
  const flips = changes(statusSeq(shown)) / mins, flipsTrue = changes(statusSeq(truth)) / mins;
  return { e, e20, cover, bands, maxAbs, resp, jit: nj ? Math.sqrt(jit / nj) : NaN, flips, flipsTrue };
}

export const rms = (a) => (a.length ? Math.sqrt(a.reduce((s, x) => s + x * x, 0) / a.length) : NaN);
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
