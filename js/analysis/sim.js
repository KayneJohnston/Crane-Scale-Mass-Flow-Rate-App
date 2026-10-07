// Synthetic crane-scale tap: used by the in-app demo and the tests.
//
// True mass follows a tap whose rate starts fast and is slowed by the
// operator, with a random wander. The display shows that mass plus load swing
// and sensor noise, rounded to 50 kg, refreshed a few times per second.
// "Touch" events (crucible resting on the cathode/cell) pull the reading down
// with a bounce until the crane lifts it. The camera reader occasionally fails
// (null) or misreads a digit.

import { mulberry32 } from '../vision/render7seg.js';

export const SIM_DEFAULTS = {
  seed: 1,
  startMass: null,          // default: random 13 000 - 15 500 kg
  tapMass: 3600,            // kg delivered in the tap
  rate0: 1050,              // kg/min at the start of the tap
  rateEnd: 650,             // kg/min the operator settles at
  rateTau: 80,              // s
  wander: 40, wanderTau: 30, // kg/min random wander (Ornstein-Uhlenbeck)
  idleBefore: 30, idleAfter: 170,
  taps: null,               // e.g. [{mass: 3600}, {mass: 3400, rate0: 800}] for a multi-pot crucible
  gapSec: 70,               // pause between taps (crane moving to the next pot)
  touches: 2, touchDepth: [300, 1500], touchDur: [3, 9],
  noise: 22,                // kg white noise per display update
  swingAmp: 30, swingPeriod: 4.3,
  displayHz: 4,
  dropProb: 0.08,           // camera frame unreadable
  misreadProb: 0.004,       // camera frame misread (one leading digit wrong)
  stepKg: 50,
  dt: 0.05,
};

function gaussOf(rnd) {
  let u = 0;
  while (u === 0) u = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

export class TapSimulator {
  constructor(opts = {}) {
    const o = (this.o = { ...SIM_DEFAULTS, ...opts });
    const rnd = mulberry32(o.seed);
    const U = ([a, b]) => a + (b - a) * rnd();
    this.frameRnd = mulberry32(o.seed * 31 + 7);
    this.startMass = o.startMass ?? 13000 + 50 * Math.floor(rnd() * 50);
    const dt = o.dt;
    const ms = [], rs = [];
    // one or more taps (a crucible may be filled from several pots)
    const plan = (o.taps || [{}]).map((p) => ({ mass: o.tapMass, rate0: o.rate0, rateEnd: o.rateEnd, ...p }));
    this.tapList = [];
    let t = 0, m = this.startMass, wander = 0, tapped = 0, k = 0, tStart = o.idleBefore, inTap = false, lastEnd = null;
    for (;;) {
      let rate = 0;
      const P = plan[k];
      if (P && !inTap && t >= tStart) { inTap = true; tapped = 0; this.tapList.push({ start: t, end: null, mass: P.mass }); }
      if (inTap) {
        const tt = t - tStart;
        wander += (-wander / o.wanderTau) * dt + o.wander * Math.sqrt((2 * dt) / o.wanderTau) * gaussOf(rnd);
        rate = P.rateEnd + (P.rate0 - P.rateEnd) * Math.exp(-tt / o.rateTau) + wander;
        rate = Math.max(0, rate * Math.min(1, tt / 3));
        tapped += (rate / 60) * dt;
        if (tapped >= P.mass) {
          inTap = false; lastEnd = t; this.tapList[k].end = t;
          k++; tStart = t + (o.gapSec ?? 70);
        }
      }
      ms.push(m); rs.push(rate);
      m += (rate / 60) * dt;
      t += dt;
      if (k >= plan.length && t > lastEnd + o.idleAfter) break;
      if (t > 7200) break;
    }
    const tapStart = this.tapList[0].start, tapEnd = this.tapList[0].end;
    this.tapStart = tapStart; this.tapEnd = tapEnd; this.duration = t;
    this.ms = ms; this.rs = rs;
    this.touches = [];
    for (const tap of this.tapList) {
      for (let i = 0; i < o.touches; i++) {
        const span = Math.max(1, tap.end - tap.start - 60);
        this.touches.push({ start: tap.start + 30 + (span * (i + rnd())) / o.touches, dur: U(o.touchDur), depth: U(o.touchDepth), ph: rnd() * 6 });
      }
    }
    this.swingPh = rnd() * 2 * Math.PI;
  }

  idx(t) { return Math.max(0, Math.min(this.ms.length - 1, Math.round(t / this.o.dt))); }
  trueMass(t) { return this.ms[this.idx(t)]; }
  /** kg/min */
  trueRate(t) { return this.rs[this.idx(t)]; }
  get trueAvgRate() { return this.avgRateOf(0); }
  avgRateOf(i) { const T = this.tapList[i]; return (T.mass / (T.end - T.start)) * 60; }

  touchEffect(t) {
    let e = 0;
    for (const T of this.touches) {
      const x = t - T.start;
      if (x < 0) continue;
      if (x <= T.dur) {
        e -= T.depth * (1 - Math.exp(-x / 0.4)) * (1 + 0.25 * Math.sin((2 * Math.PI * x) / 1.3 + T.ph) * Math.exp(-x / 4));
      } else if (x <= T.dur + 3) {
        const y = x - T.dur;
        e -= T.depth * Math.exp(-y / 0.25);
        e += 0.2 * T.depth * Math.exp(-y / 0.8) * Math.sin((2 * Math.PI * y) / 0.9);
      }
    }
    return e;
  }

  inTouch(t) { return this.touches.some((T) => t >= T.start && t <= T.start + T.dur + 1); }

  /** Value shown on the scale display at time t. */
  displayValue(t) {
    const o = this.o;
    const k = Math.floor(t * o.displayHz);
    const td = k / o.displayHz;
    const r = mulberry32((o.seed * 7919) ^ (k * 2654435761));
    const noise = o.noise * gaussOf(r) + o.swingAmp * Math.sin((2 * Math.PI * td) / o.swingPeriod + this.swingPh);
    const v = this.trueMass(td) + this.touchEffect(td) + noise;
    return Math.round(v / o.stepKg) * o.stepKg;
  }

  /** What the camera reader reports for a frame at time t (sequential calls). */
  frame(t) {
    const o = this.o, r = this.frameRnd;
    const u = r();
    if (u < o.dropProb) return { value: null, conf: 0 };
    let value = this.displayValue(t);
    if (u < o.dropProb + o.misreadProb) {
      const s = String(value).split('');
      const pos = Math.floor(r() * Math.min(3, s.length));
      s[pos] = String((+s[pos] + 1 + Math.floor(r() * 9)) % 10);
      value = +s.join('');
    }
    return { value, conf: 0.6 + 0.4 * r() };
  }
}
