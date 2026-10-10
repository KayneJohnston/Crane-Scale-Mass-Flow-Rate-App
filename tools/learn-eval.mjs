// Does learning from the person's answers (js/vision/learn.js) make the reader better
// - on the frames it was taught with, and on frames it has not seen - and never worse?
//   node tools/learn-eval.mjs video <dir> <truth.json> [--labels n] [--gap s] [-v]
//        frames of a real video (f001.png ..., 10 a second), truth: {frame number: kg}
//   node tools/learn-eval.mjs synth [displays] [--labels n] [--gap s] [--offset n] [--faint json] [-v]
//   node tools/learn-eval.mjs fives [level]
//
// The person answers frames the reader did not read right (with the reading history,
// as live: where the app would ask, or keep the picture for Review) - at least `gap`
// seconds apart, up to n of them - with the true value. Then:
//   next run: the same frames are read again with what was learned;
//   held out: learned from the answers in the first half only, the second half is read
//     with and without it. The second half shows other values (the weight rises), so
//     a look learned for one digit is also tried on its neighbours.
// Each frame is read on its own (as "Test reader" in Review) and with the reading
// history (as live). LEARN='{"minVotes":1}' and READ='{...}' override the settings of
// learn.js and of the reader.
//
// synth: displays in a heavy glow (tools/vision-eval.mjs hotScene, the over-exposed
// look of the real scale), each one look kept while its value rises in 50 kg steps.
// --faint '{"5":{"b":0.7}}': segments the glow lights a little (render7seg.js faint), as
// the real display lit segment b of its 5s (5 or 9?).
//
// fives: a red display (as in tests/e2e/learn.mjs) whose 5s light segment b this much
// (default 0.6), so they look like 9s. The person says twice that it shows 18,550; then
// 60 s of the weight rising 50 kg every 3 s from 18,400 are read with the history, with
// and without what was learned.
import { readFileSync, readdirSync } from 'node:fs';
import { decodePNG } from './png.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { renderDisplay } from '../js/vision/render7seg.js';
import { DigitMemory, lessonsOf } from '../js/vision/learn.js';
import { READ_DEFAULTS } from '../js/vision/sevenseg.js';
import { hotScene } from './vision-eval.mjs';

const [cmd, ...rest] = process.argv.slice(2);
const argS = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const arg = (k, d) => +argS(k, d);
const nLabels = arg('--labels', 10), gap = arg('--gap', 2), verbose = process.argv.includes('-v');
const CFG = { minKg: 1000, maxKg: 40000, stepKg: 50, multiplier: 1 };
const LCFG = { ...CFG, minMargin: READ_DEFAULTS.minMargin, maxCost: READ_DEFAULTS.maxCost };
const LEARN = JSON.parse(process.env.LEARN || '{}'), RCFG = JSON.parse(process.env.READ || '{}');

// read frames [{t, truth, load}] in time order, each on its own and with the history
// (single: the readings on their own, if already known)
function run(frames, cfg, single = null) {
  const track = {};
  return frames.map((f, i) => {
    const { sample, W, H } = f.load();
    const view = { x: 0, y: 0, w: W, h: H };
    const a = single ? single[i] : readFrame(sample, W, H, view, cfg);
    const b = readFrame(sample, W, H, view, cfg, track, f.t);
    return { single: single ? a : a.ok ? a.value : null, seq: b.ok ? b.value : null, lattices: b.lattices };
  });
}

const score = (frames, out) => {
  const T = { n: 0, single: 0, singleWrong: 0, seq: 0, seqWrong: 0 };
  frames.forEach((f, i) => {
    const o = out[i];
    T.n++;
    if (o.single != null) { T.single++; if (o.single !== f.truth) T.singleWrong++; }
    if (o.seq != null) { T.seq++; if (o.seq !== f.truth) T.seqWrong++; }
  });
  return T;
};
const pct = (a, b) => `${(100 * a / Math.max(1, b)).toFixed(0)}%`;
const line = (B, A) => `read on its own ${pct(B.single, B.n)} -> ${pct(A.single, A.n)} (wrong ${B.singleWrong} -> ${A.singleWrong})` +
  ` | with history ${pct(B.seq, B.n)} -> ${pct(A.seq, A.n)} (wrong ${B.seqWrong} -> ${A.seqWrong})`;

const sum = {};
const add = (k, B, A) => {
  sum[k] ||= { before: {}, after: {} };
  for (const [x, v] of Object.entries(B)) sum[k].before[x] = (sum[k].before[x] || 0) + v;
  for (const [x, v] of Object.entries(A)) sum[k].after[x] = (sum[k].after[x] || 0) + v;
};

function evaluate(frames, label) {
  const half = Math.floor(frames.length / 2);
  const before = run(frames, CFG);
  // the answers: frames not read right with the history, `gap` s apart
  const asked = [];
  let lastT = -Infinity;
  frames.forEach((f, i) => {
    if (asked.length >= nLabels || f.t - lastT < gap || before[i].seq === f.truth) return;
    const items = lessonsOf({ lattices: before[i].lattices }, f.truth, LCFG);
    if (!items.length) return;
    asked.push({ i, items });
    lastT = f.t;
  });
  const teach = (list) => { const m = new DigitMemory(null, LEARN); for (const a of list) m.learn(a.items); return m; };
  const memAll = teach(asked), memHalf = teach(asked.filter((a) => a.i < half));
  const after = run(frames, { ...CFG, ...RCFG, learned: memAll.active() });
  const B1 = score(frames, before), A1 = score(frames, after);
  // held out: the second half alone (its own history), without and with the first half's answers
  const test = frames.slice(half);
  const hb = run(test, CFG, before.slice(half).map((o) => o.single));
  const ha = run(test, { ...CFG, ...RCFG, learned: memHalf.active() });
  const B2 = score(test, hb), A2 = score(test, ha);
  const st = memAll.stats(), sh = memHalf.stats();
  console.log(`${label}: ${frames.length} frames, ${asked.length} answers (${asked.filter((a) => a.i < half).length} in the first half); digit shapes in use ${st.used} (first half: ${sh.used})`);
  console.log(`   next run, same frames:  ${line(B1, A1)}`);
  console.log(`   held out, second half:  ${line(B2, A2)}`);
  if (verbose) {
    frames.forEach((f, i) => {
      const b = before[i], a = after[i];
      if (b.single !== a.single || b.seq !== a.seq) console.log(`     t ${f.t.toFixed(1)} truth ${f.truth}: on its own ${b.single ?? '-'} -> ${a.single ?? '-'}, with history ${b.seq ?? '-'} -> ${a.seq ?? '-'}`);
    });
  }
  add('next run', B1, A1);
  add('held out', B2, A2);
}

if (cmd === 'video') {
  const [dir, truthFile] = rest;
  const truth = JSON.parse(readFileSync(truthFile, 'utf8'));
  const files = readdirSync(dir).filter((f) => /^f\d+\.png$/.test(f)).sort();
  // (decoded when used: a minute of full-size video frames does not fit in memory at once)
  const frames = files.map((f, i) => ({
    t: i / 10, truth: truth[+f.slice(1, -4)],
    load: () => { const { width: W, height: H, data } = decodePNG(readFileSync(`${dir}/${f}`)); return { sample: makeSampler(data, W, H), W, H }; },
  })).filter((f) => f.truth);
  evaluate(frames, dir.split('/').pop());
} else if (cmd === 'synth') {
  const displays = +(rest[0] || 12), offset = arg('--offset', 0), faint = JSON.parse(argS('--faint', 'null'));
  for (let s = 1 + offset; s <= displays + offset; s++) {
    const start = 13000 + 50 * Math.floor(((s * 7919) % 200));
    const frames = [];
    for (let k = 0; k < 80; k++) {
      const t = k * 0.5, value = start + 50 * Math.floor(k / 4); // a new value every 2 s
      const sc = hotScene(s, { value });
      sc.opts.seed = 1000 * s + k; // fresh noise, same display
      sc.opts.faint = faint;
      sc.opts.cx += 6 * Math.sin(k * 0.7); sc.opts.cy += 3 * Math.cos(k * 1.1);
      const buf = new Uint8ClampedArray(sc.W * sc.H * 4);
      renderDisplay(buf, sc.W, sc.H, sc.opts);
      const fr = { sample: makeSampler(buf, sc.W, sc.H), W: sc.W, H: sc.H };
      frames.push({ t, truth: value, load: () => fr });
    }
    evaluate(frames, `display ${s}`);
  }
  for (const [k, { before, after }] of Object.entries(sum)) console.log(`all, ${k}: ${line(before, after)}`);
} else if (cmd === 'fives') {
  const level = +(rest[0] || 0.6), W = 960, H = 540;
  const view = { x: W / 2 - W / 2.8, y: H / 2 - H / 2.8, w: W / 1.4, h: H / 1.4 }; // (zoomed in 1.4x)
  const frame = (value, seed) => {
    const buf = new Uint8ClampedArray(W * H * 4);
    renderDisplay(buf, W, H, { text: String(value), digitH: 34, cx: W / 2 + 20 * Math.sin(seed * 0.3), cy: H / 2, slantDeg: 7, noise: 3, glow: 0.35, seed, faint: { 5: { b: level } } });
    return makeSampler(buf, W, H);
  };
  const mem = new DigitMemory(null, LEARN);
  for (const seed of [900, 901]) mem.learn(lessonsOf(readFrame(frame(18550, seed), W, H, view, CFG), 18550, LCFG));
  for (const [name, cfg] of [['before', CFG], ['after', { ...CFG, ...RCFG, learned: mem.active() }]]) {
    const track = {}, T = { right: 0, wrong: 0 }, wrong = {};
    for (let k = 0; k < 300; k++) { // 5 frames a second
      const t = k * 0.2, value = 18400 + 50 * Math.floor(t / 3);
      const r = readFrame(frame(value, k + 1), W, H, view, cfg, track, t);
      if (r.ok && r.value === value) T.right++;
      else if (r.ok) { T.wrong++; wrong[`${value} as ${r.value}`] = (wrong[`${value} as ${r.value}`] || 0) + 1; }
    }
    const what = name === 'before' ? 'the reader alone' : `with ${mem.stats().used} digit shape${mem.stats().used === 1 ? '' : 's'} learned`;
    console.log(`${what}: ${T.right} of 300 frames read right, ${T.wrong} wrong ${T.wrong ? JSON.stringify(wrong) : ''}`);
  }
}
