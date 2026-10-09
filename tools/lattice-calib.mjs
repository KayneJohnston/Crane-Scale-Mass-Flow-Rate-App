// How far can the reader's digit costs be trusted as probabilities?
//   node tools/lattice-calib.mjs collect <out.jsonl> [count] [--offset n]   synthetic frames
//   node tools/lattice-calib.mjs unclear <out.jsonl> [count] [--offset n]   harsher ones, unclear readings only
//   node tools/lattice-calib.mjs real <out.jsonl> <dir> <truth.json>         real frames (f001.png ...)
//   node tools/lattice-calib.mjs fit <file.jsonl> [...]                      fit the temperature
//
// collect/real: each frame is read in red and in over-exposed ("hot") mode, and the
// per-digit costs of every reading with the true digit count are saved with the true
// value. fit: P(picture | value) is modelled as exp(-cost(value) / T), cost = the sum
// of its digits' costs. T is fitted so that, with every value within 1000 kg of the
// truth equally likely beforehand, the probability given to the true value is right on
// average (maximum likelihood); then the stated and the actual hit rates are compared.
import { readFileSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { renderDisplay, mulberry32 } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { readDigits } from '../js/vision/sevenseg.js';
import { decodePNG } from './png.js';
import { randomScene, hotScene } from './vision-eval.mjs';

const [cmd, out, ...rest] = process.argv.slice(2);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };

function record(kind, id, truth, sample, W, H, unclearOnly = false) {
  const lines = [];
  for (const mode of ['red', 'hot']) {
    const r = readFrame(sample, W, H, { x: 0, y: 0, w: W, h: H }, { colorMode: mode });
    const lat = r.lattice;
    if (!lat || lat.n !== String(truth).length || (unclearOnly && r.ok)) continue;
    lines.push(JSON.stringify({ kind, id, mode, truth, ok: !!r.ok, value: r.ok ? r.value : null, costs: lat.costs.map((c) => Array.from(c, (x) => +x.toFixed(3))) }));
  }
  return lines;
}

if (cmd === 'collect') {
  const count = +(rest[0] || 200), offset = arg('--offset', 0);
  writeFileSync(out, '');
  const kinds = [['normal', (s) => randomScene(s)], ['hard', (s) => randomScene(s, true)], ['hot', (s) => hotScene(s)], ['dashes', (s) => hotScene(s, { dashes: true })]];
  for (let s = 1 + offset; s <= count + offset; s++) {
    for (const [kind, make] of kinds) {
      const { W, H, value, opts } = make(s);
      const buf = new Uint8ClampedArray(W * H * 4);
      renderDisplay(buf, W, H, opts);
      const lines = record(kind, s, value, makeSampler(buf, W, H), W, H);
      if (lines.length) appendFileSync(out, lines.join('\n') + '\n');
    }
  }
} else if (cmd === 'unclear') {
  // Frames the reader can't decide, from frames it can: the digits are read again at
  // thresholds away from the usual one, where faint strokes drop out or the glow fills
  // in holes - the ways real frames go wrong (unlit segments showing through, too).
  const count = +(rest[0] || 200), offset = arg('--offset', 0);
  writeFileSync(out, '');
  for (let s = 1 + offset; s <= count + offset; s++) {
    const rnd = mulberry32(s);
    const a = randomScene(50000 + s, true);
    if (rnd() < 0.5) a.opts.ghost = 0.3 + 0.3 * rnd();
    const b = hotScene(60000 + s, { dashes: rnd() < 0.5 });
    for (const [kind, sc] of [['ghost', a], ['glow', b]]) {
      const buf = new Uint8ClampedArray(sc.W * sc.H * 4);
      renderDisplay(buf, sc.W, sc.H, sc.opts);
      const r = readFrame(makeSampler(buf, sc.W, sc.H), sc.W, sc.H, { x: 0, y: 0, w: sc.W, h: sc.H }, { keepDebug: true });
      const crop = r.debug?.read;
      if (!crop || !r.mode || r.mode === 'bright') continue;
      const lines = [];
      for (const relThr of [0.3, 0.38, 0.45, 0.55, 0.62, 0.7, 0.78, 0.86]) {
        // (above the usual threshold the rest of a "1"'s cell must be dark at the usual one, as when reading)
        const d = readDigits(crop.img, crop.w, crop.h, { colorMode: r.mode, relThr, ...(relThr > 0.5 ? { refRelThr: 0.5 } : {}), maxDigits: 5, expectDigits: String(sc.value).length });
        if (d.ok || !d.lattice || d.lattice.n !== String(sc.value).length) continue;
        lines.push(JSON.stringify({ kind, id: s, mode: r.mode, relThr, truth: sc.value, ok: false, value: null, costs: d.lattice.costs.map((c) => Array.from(c, (x) => +x.toFixed(3))) }));
      }
      if (lines.length) appendFileSync(out, lines.join('\n') + '\n');
    }
  }
} else if (cmd === 'real') {
  const [dir, truthFile] = rest;
  const truth = JSON.parse(readFileSync(truthFile, 'utf8'));
  writeFileSync(out, '');
  for (const f of readdirSync(dir).filter((x) => /^f\d+\.png$/.test(x)).sort()) {
    const want = truth[+f.slice(1, -4)];
    if (!want) continue;
    const { width: W, height: H, data } = decodePNG(readFileSync(`${dir}/${f}`));
    const lines = record('real', f, want, makeSampler(data, W, H), W, H);
    if (lines.length) appendFileSync(out, lines.join('\n') + '\n');
  }
} else if (cmd === 'fit') {
  const rows = [out, ...rest].flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const STEP = 50, WIN = 1000;
  // for each reading: the cost of the true value and of every other value nearby
  const sets = rows.map((r) => {
    const n = r.costs.length, cs = [];
    let truthCost = null;
    for (let v = r.truth - WIN; v <= r.truth + WIN; v += STEP) {
      const s = String(v);
      if (v <= 0 || s.length !== n) continue;
      let c = 0;
      for (let i = 0; i < n; i++) c += r.costs[i][s.charCodeAt(i) - 48];
      cs.push(c);
      if (v === r.truth) truthCost = c;
    }
    return { ...r, cs, truthCost };
  });
  const logLik = (T, list) => {
    let ll = 0;
    for (const s of list) {
      const m = Math.min(...s.cs);
      let z = 0;
      for (const c of s.cs) z += Math.exp(-(c - m) / T);
      ll += -(s.truthCost - m) / T - Math.log(z);
    }
    return ll;
  };
  const fitT = (list) => {
    let best = null;
    for (let T = 0.05; T <= 3; T += 0.01) { const ll = logLik(T, list); if (!best || ll > best.ll) best = { T, ll }; }
    return best;
  };
  const groups = { all: sets, clear: sets.filter((s) => s.ok), unclear: sets.filter((s) => !s.ok) };
  for (const kind of [...new Set(sets.map((s) => s.kind))]) groups[kind + ' unclear'] = sets.filter((s) => s.kind === kind && !s.ok);
  for (const [name, list] of Object.entries(groups)) {
    if (!list.length) continue;
    const f = fitT(list);
    console.log(`${name.padEnd(16)} readings ${String(list.length).padStart(5)}  T = ${f.T.toFixed(2)}`);
  }
  // reliability: stated probability of the most probable value vs how often it is right
  const T = +(process.env.T || fitT(groups.unclear.length ? groups.unclear : sets).T);
  const bins = [0.5, 0.8, 0.9, 0.95, 0.99, 0.999, 1.01];
  const tally = bins.map(() => ({ n: 0, hit: 0, p: 0 }));
  for (const s of groups.unclear) {
    const m = Math.min(...s.cs);
    let z = 0;
    for (const c of s.cs) z += Math.exp(-(c - m) / T);
    const pBest = 1 / z, hit = s.truthCost === m;
    const k = bins.findIndex((b) => pBest < b);
    if (k < 0) continue;
    tally[k].n++; tally[k].hit += hit ? 1 : 0; tally[k].p += pBest;
  }
  console.log(`\nunclear readings at T = ${T.toFixed(2)}: stated probability of the best value vs how often it was right`);
  let lo = 0;
  tally.forEach((t, k) => {
    if (t.n) console.log(`  ${lo.toFixed(3)}-${Math.min(1, bins[k]).toFixed(3)}  n ${String(t.n).padStart(5)}  stated ${(100 * t.p / t.n).toFixed(1)}%  right ${(100 * t.hit / t.n).toFixed(1)}%`);
    lo = bins[k];
  });
}
