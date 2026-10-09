// Stress test of the reading decisions (tracker.js) over simulated taps, without
// rendering: each frame's reader output is drawn from a deliberately pessimistic model.
//   node tools/tracker-sim.mjs [taps] [--offset n]
//
// Mostly clear frames, with some unclear ones (one digit doubtful) and rare misreads.
// In "unclear spells" (8-30 s, every 40-90 s, like a glowing 8 the reader can't make
// out) no frame reads clearly: an 8 or a 1 is doubtful - and often looks more like
// a digit one segment away than like itself - and 8% of the frames are read with a
// digit lost. Compares the reading history alone with the history helped by the tap
// engine's expectation (TapEngine.expectation): share of frames given a value, and
// wrong values. The model is harsher than the real reader, so the wrong values are
// an upper bound on the risk, not an estimate of it.
import { TapSimulator } from '../js/analysis/sim.js';
import { TapEngine } from '../js/analysis/engine.js';
import { DisplayTracker, TRACK_DEFAULTS } from '../js/vision/tracker.js';
import { TEMPLATES } from '../js/vision/sevenseg.js';
import { mulberry32 } from '../js/vision/render7seg.js';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
const nTaps = +(process.argv[2] || 20), offset = arg('--offset', 0);
const CFG = { ...TRACK_DEFAULTS, minKg: 1000, maxKg: 40000, stepKg: 50, multiplier: 1 };
const fps = 10;

const SEGS = {};
for (const t of TEMPLATES) if (!SEGS[t.ch]) SEGS[t.ch] = t.v;
const ham = (a, b) => SEGS[a].reduce((s, x, i) => s + Math.abs(x - SEGS[b][i]), 0);
const NEAR = {}; // digits one or two segments away
for (let a = 0; a < 10; a++) NEAR[a] = [...Array(10).keys()].filter((b) => b !== a && ham(String(a), String(b)) <= 2);
const gauss = (r) => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); };

// per-digit costs as the reader reports them (~0.3 for the shown digit, ~1 per segment
// that differs); a doubtful digit fits worse, and a neighbour may fit better
function lattice(r, text, doubtful) {
  const costs = [...text].map((ch, i) => {
    const d = +ch, c = new Float64Array(10);
    for (let k = 0; k < 10; k++) c[k] = Math.max(0.05, 0.3 + ham(ch, String(k)) + 0.25 * gauss(r));
    if (doubtful.includes(i)) {
      c[d] += 0.3 + 1.6 * r();
      const e = NEAR[d][Math.floor(r() * NEAR[d].length)];
      c[e] = Math.max(0.1, Math.min(c[e], c[d] + (r() - 0.6) * 1.2));
    }
    return c;
  });
  return { n: text.length, costs };
}
const clear = (r, text) => ({ ok: true, value: +text, lattice: lattice(r, text, []) });
const lost = (s) => { const i = s.search(/[10]/); return i >= 0 ? s.slice(0, i) + s.slice(i + 1) : null; };

function readerOut(r, truth, unclear) {
  const s = String(truth), u = r();
  if (unclear) {
    const pos = [...s].map((ch, i) => (ch === '8' || ch === '1' ? i : -1)).filter((i) => i >= 0);
    if (u < 0.08 && lost(s)) return clear(r, lost(s));
    if (u < 0.75) return { ok: false, lattice: lattice(r, s, pos.length ? pos : [Math.floor(r() * s.length)]) };
    return { ok: false, lattice: null };
  }
  if (u < 0.8) return clear(r, s);
  if (u < 0.803) { // a digit misread as one a segment or two away
    const i = Math.floor(r() * s.length), d = +s[i];
    return clear(r, s.slice(0, i) + NEAR[d][Math.floor(r() * NEAR[d].length)] + s.slice(i + 1));
  }
  if (u < 0.805 && lost(s)) return clear(r, lost(s));
  if (u < 0.95) return { ok: false, lattice: lattice(r, s, [Math.floor(r() * s.length)]) };
  return { ok: false, lattice: null };
}

// what the reader itself refuses: not a 50 kg step in the range, or a digit count the
// prediction rules out (pipeline.js expectDigits)
function gate(res, pred) {
  if (res.ok && (res.value % CFG.stepKg || res.value < CFG.minKg || res.value > CFG.maxKg)) return { ok: false, lattice: res.lattice };
  if (!pred) return res;
  const a = String(Math.round(Math.max(CFG.minKg, pred.value - pred.band))).length;
  const b = String(Math.round(Math.min(CFG.maxKg, pred.value + pred.band))).length;
  if (a !== b) return res;
  if (res.ok && String(res.value).length !== a) return { ok: false, lattice: null };
  return res.lattice && res.lattice.n !== a ? { ...res, lattice: null } : res;
}

const mk = () => ({ n: 0, val: 0, wrong: 0, big: 0, nU: 0, valU: 0, wrongU: 0 });
const tot = { history: mk(), engine: mk() };
for (let s = 1 + offset; s <= nTaps + offset; s++) {
  const sim = new TapSimulator({ seed: s, touches: 2, displayHold: s % 2 ? [1, 12] : null, taps: s % 3 === 0 ? [{ mass: 3500 }, { mass: 3000 }] : null, startMass: 16000 + 50 * (s % 40) });
  const r = mulberry32(s * 101 + 5);
  const spells = [];
  for (let t = sim.tapStart + 10 * r(); t < sim.duration; t += 40 + 50 * r()) spells.push([t, t + 8 + 22 * r()]);
  const trH = new DisplayTracker(), trE = new DisplayTracker();
  const eng = new TapEngine({});
  for (let k = 0; k < sim.duration * fps; k++) {
    const t = k / fps, truth = sim.displayValue(t);
    const unclear = spells.some(([a, b]) => t >= a && t < b);
    const raw = readerOut(r, truth, unclear);
    const pH = trH.predict(t, CFG);
    const dH = trH.decide(t, [gate(raw, pH)], CFG, pH);
    const pE = trE.predict(t, CFG, eng.expectation(t));
    const dE = trE.decide(t, [gate(raw, pE)], CFG, pE);
    eng.pushFrame(t, Date.now() + t * 1000, dE.value, 0.8, dE.how);
    if (!eng.sess) continue; // frames of the recording only
    for (const [key, d] of [['history', dH], ['engine', dE]]) {
      const T = tot[key];
      T.n++; if (unclear) T.nU++;
      if (d.value == null) continue;
      T.val++; if (unclear) T.valU++;
      if (d.value !== truth) { T.wrong++; if (unclear) T.wrongU++; if (Math.abs(d.value - truth) > 150) T.big++; }
    }
  }
}
const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(1)}%`;
console.log(`${nTaps} simulated taps, ${fps} frames/s`);
for (const [key, T] of Object.entries(tot)) {
  console.log(`  ${key === 'history' ? 'reading history       ' : 'history + tap engine  '} value given ${pct(T.val, T.n)}, wrong ${T.wrong} (${(100 * T.wrong / T.n).toFixed(3)}%, ${T.big} off by more than 150 kg)` +
    ` | in unclear spells: value given ${pct(T.valU, T.nU)}, wrong ${T.wrongU}`);
}
