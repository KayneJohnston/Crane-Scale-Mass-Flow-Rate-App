import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lessons, lessonsOf, DigitMemory } from '../js/vision/learn.js';
import { readDigits, READ_DEFAULTS } from '../js/vision/sevenseg.js';
import { renderDisplay } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';

// costs of reading a glyph as 0-9: low for `d`, `gap` higher for `rival`, 3 for the rest
const costs = (d, rival = null, gap = 3) => Float64Array.from({ length: 10 }, (_, k) => (k === d ? 0.4 : k === rival ? 0.4 + gap : 3.4));
const NV5 = [1, 0.62, 1, 1, 0.05, 1, 1]; // a glowing 5: segment b half lit, as a 9
const NV9 = [1, 1, 1, 1, 0.05, 1, 1];

test('lessons: the glyphs the reader was not sure of (or got wrong), with the true digit', () => {
  const L = { n: 5, mode: 'hot', nv: [NV9, NV9, NV5, NV9, NV9], costs: [costs(1), costs(3), costs(9, 5, 0.3), costs(5), costs(0)] };
  // 13550: the third digit was taken for a 9 by a hair (unsure), the fourth for a 5 (sure)
  assert.deepEqual(lessons(L, 13550), [{ mode: 'hot', v: NV5, d: 5 }]);
  // a digit read clearly but wrong is learned too (the fourth: read 5, really 9)
  assert.deepEqual(lessons(L, 13590).map((x) => x.d), [5, 9]);
  assert.deepEqual(lessons(L, 3550), []); // a digit lost or added: no telling which is which
  assert.deepEqual(lessons({ ...L, nv: [null, NV9, null, NV9, NV9] }, 13550), []); // no fills: nothing to learn
  assert.deepEqual(lessons(null, 13550), []);
  // every colour mode the frame was read in
  const res = { lattices: [L, { ...L, mode: 'red' }] };
  assert.deepEqual(lessonsOf(res, 13550).map((x) => x.mode), ['hot', 'red']);
  assert.deepEqual(lessonsOf({ lattice: L }, 13550).length, 1);
  assert.deepEqual(lessonsOf({}, 13550), []);
});

test('a look is used once the person said the same digit about it twice', () => {
  const m = new DigitMemory();
  m.learn([{ mode: 'hot', v: NV5, d: 5 }]);
  assert.deepEqual(m.active(), {});
  m.learn([{ mode: 'hot', v: NV5.map((x, i) => (i === 1 ? 0.7 : x)), d: 5 }]); // close: the same look
  assert.equal(m.looks.length, 1);
  const a = m.active();
  assert.equal(a.hot.length, 1);
  assert.equal(a.hot[0].d, 5);
  assert.ok(Math.abs(a.hot[0].v[1] - 0.66) < 1e-9, 'the look is the mean of what was seen');
  assert.equal(a.red, undefined, 'only in the colour mode it was seen in');
  m.learn([{ mode: 'hot', v: [1, 0, 1, 1, 1, 1, 1], d: 6 }]); // far: a new look
  assert.equal(m.looks.length, 2);
  assert.deepEqual(m.stats(), { answers: 3, looks: 2, used: 1 });
});

test('a look the person called different digits is not used', () => {
  const m = new DigitMemory();
  for (const d of [5, 5, 9]) m.learn([{ mode: 'hot', v: NV5, d }]);
  assert.deepEqual(m.active(), {}, '2 of 3 is not enough');
  for (let k = 0; k < 9; k++) m.learn([{ mode: 'hot', v: NV5, d: 5 }]);
  assert.equal(m.active().hot[0].d, 5, '11 of 12 is');
});

test('an answer can be taken back; the memory survives a restart and can be forgotten', () => {
  const m = new DigitMemory();
  const t1 = m.learn([{ mode: 'hot', v: NV5, d: 5 }]);
  const t2 = m.learn([{ mode: 'hot', v: NV5, d: 5 }]);
  assert.equal(m.stats().used, 1);
  m.unlearn(t2);
  assert.deepEqual(m.stats(), { answers: 1, looks: 1, used: 0 });
  m.unlearn(t1);
  assert.deepEqual(m.stats(), { answers: 0, looks: 0, used: 0 });
  m.unlearn(t1); // twice: nothing left to take back
  assert.deepEqual(m.stats(), { answers: 0, looks: 0, used: 0 });

  for (let k = 0; k < 2; k++) m.learn([{ mode: 'hot', v: NV5, d: 5 }, { mode: 'red', v: NV9, d: 9 }]);
  const back = new DigitMemory(JSON.parse(JSON.stringify(m)));
  assert.deepEqual(back.active(), m.active());
  const t3 = back.learn([{ mode: 'red', v: [0, 1, 1, 0, 0, 0, 0], d: 1 }]);
  assert.ok(t3[0].id > Math.max(...m.looks.map((L) => L.id)), 'new looks get new ids');
  back.forget();
  assert.deepEqual(back.stats(), { answers: 0, looks: 0, used: 0 });
  // after forgetting (and a restart) new looks get new ids: an old picture's label,
  // changed in Review, takes back nothing from them
  const again = new DigitMemory(JSON.parse(JSON.stringify(back)));
  const t4 = again.learn([{ mode: 'red', v: NV9, d: 9 }]);
  assert.ok(t4[0].id > t3[0].id);
  again.unlearn(t3);
  assert.deepEqual(again.stats(), { answers: 1, looks: 1, used: 0 });
  assert.deepEqual(new DigitMemory({ looks: [{ v: [1, 2] }, null] }).looks, [], 'damaged state is dropped');
});

test('at most maxLooks are kept: the least used, oldest go first', () => {
  const m = new DigitMemory(null, { maxLooks: 3 });
  const look = (k) => [k / 10, 0, 0, 0, 0, 0, 0].map((x, i) => (i === 0 ? x : (k * (i + 1)) % 2));
  m.learn([{ mode: 'red', v: look(1), d: 1 }], 1);
  m.learn([{ mode: 'red', v: look(1), d: 1 }], 2); // two votes
  m.learn([{ mode: 'red', v: [0, 0, 0, 0, 0, 0, 0], d: 2 }], 3);
  m.learn([{ mode: 'red', v: [1, 1, 1, 1, 1, 1, 1], d: 8 }], 4);
  m.learn([{ mode: 'red', v: [1, 1, 1, 1, 1, 1, 0], d: 0 }], 5);
  assert.deepEqual(m.looks.map((L) => Object.keys(L.votes)[0]).sort(), ['0', '1', '8']);
});

// the reader with learned looks: a clean 13050 (red)
function frame(text) {
  const W = 640, H = 360, buf = new Uint8ClampedArray(W * H * 4);
  renderDisplay(buf, W, H, { text, digitH: 50 });
  return { buf, W, H };
}

test('the reader: a learned look of another digit makes a glyph doubtful, never confident', () => {
  const { buf, W, H } = frame('13050');
  const r0 = readDigits(buf, W, H);
  assert.equal(r0.ok, true);
  assert.equal(r0.text, '13050');
  const nv = r0.lattice.nv[1];
  assert.equal(r0.lattice.mode, 'red');
  assert.ok(nv && nv.length === 7, 'the segment fills are kept with the costs');

  // a look of an 8 just where this 3 is: no longer read on its own
  const r8 = readDigits(buf, W, H, { learned: { red: [{ d: 8, v: nv }] } });
  assert.equal(r8.ok, false);
  assert.equal(r8.reason, 'learned-doubt');
  assert.ok(Math.abs(r8.lattice.costs[1][8] - READ_DEFAULTS.learnedPenalty) < 0.01, 'the 8 fits as well as the look (+ penalty)');
  assert.equal(r8.lattice.costs[1][3], r0.lattice.costs[1][3], 'the 3 fits as before');

  // a look of the digit it is: read as before
  const r3 = readDigits(buf, W, H, { learned: { red: [{ d: 3, v: nv }] } });
  assert.equal(r3.ok, true);
  assert.equal(r3.text, '13050');
  // a look in another colour mode, or far from this glyph: no effect
  for (const learned of [{ hot: [{ d: 8, v: nv }] }, { red: [{ d: 8, v: [0, 0, 0, 0, 0, 0, 0] }] }]) {
    const r = readDigits(buf, W, H, { learned });
    assert.equal(r.ok, true);
    assert.deepEqual(r.lattice.costs.map((c) => Array.from(c)), r0.lattice.costs.map((c) => Array.from(c)));
  }
});

test('one answer is one vote for a look, however many digits showed it', () => {
  const m = new DigitMemory();
  const tok = m.learn([{ mode: 'hot', v: NV5, d: 5 }, { mode: 'hot', v: NV5, d: 5 }, { mode: 'hot', v: NV5, d: 5 }]); // 25,550
  assert.equal(tok.length, 1);
  assert.deepEqual(m.looks[0].votes, { 5: 1 });
  assert.deepEqual(m.active(), {}, 'not used after a single answer');
  m.unlearn(tok);
  assert.equal(m.looks.length, 0);
});

test('a display whose 5s glow like 9s: after two answers, read right more often and never wrong', () => {
  const CFG = { minKg: 1000, maxKg: 40000, stepKg: 50, multiplier: 1 };
  const W = 640, H = 360, view = { x: 0, y: 0, w: W, h: H };
  const frame = (value, seed) => {
    const buf = new Uint8ClampedArray(W * H * 4);
    renderDisplay(buf, W, H, { text: String(value), digitH: 30, cx: W / 2 + 12 * Math.sin(seed * 0.3), cy: H / 2, slantDeg: 7, noise: 3, glow: 0.35, seed, faint: { 5: { b: 0.6 } } });
    return makeSampler(buf, W, H);
  };
  // the person says twice that the display holding 18,550 shows 18,550
  const m = new DigitMemory();
  for (const seed of [900, 901]) m.learn(lessonsOf(readFrame(frame(18550, seed), W, H, view, CFG), 18550, CFG));
  assert.equal(m.stats().used, 1);
  // 10 s of a weight rising 50 kg every 3 s, read with the history (as live)
  const run = (cfg) => {
    const track = {}, T = { right: 0, wrong: 0 };
    for (let k = 0; k < 40; k++) {
      const t = k * 0.25, value = 18450 + 50 * Math.floor(t / 3);
      const r = readFrame(frame(value, k + 1), W, H, view, cfg, track, t);
      if (r.ok) T[r.value === value ? 'right' : 'wrong']++;
    }
    return T;
  };
  const before = run(CFG), after = run({ ...CFG, learned: m.active() });
  assert.ok(before.wrong > 0, `the reader alone misreads it (${JSON.stringify(before)})`);
  assert.equal(after.wrong, 0, `never wrong after learning (${JSON.stringify(after)})`);
  assert.ok(after.right > before.right, `read right more often (${before.right} -> ${after.right})`);
});
