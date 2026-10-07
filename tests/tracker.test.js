import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplayTracker, bestInBand } from '../js/vision/tracker.js';
import { TEMPLATES } from '../js/vision/sevenseg.js';

const CFG = { minKg: 10000, maxKg: 30000, stepKg: 50, multiplier: 1 };
const SEGS = {};
for (const t of TEMPLATES) if (!SEGS[t.ch]) SEGS[t.ch] = t.v;
const ham = (a, b) => SEGS[a].reduce((s, x, i) => s + Math.abs(x - SEGS[b][i]), 0);

// per-digit costs as the reader produces them: ~0.3 for the shown digit, ~1 per differing segment
function lattice(text, tweak = {}) {
  const costs = [...text].map((ch, i) => {
    const c = new Float64Array(10);
    for (let d = 0; d < 10; d++) c[d] = String(d) === ch ? 0.3 : 0.3 + ham(ch, String(d));
    for (const [d, v] of Object.entries(tweak[i] || {})) c[+d] = v;
    return c;
  });
  return { n: text.length, costs };
}
const clear = (v) => ({ ok: true, value: v, lattice: lattice(String(v)) });
const unread = (lat) => ({ ok: false, value: null, lattice: lat });

function locked(t0 = 0, v = 20050) {
  const tr = new DisplayTracker();
  tr.decide(t0, [clear(v)], CFG);
  const d = tr.decide(t0 + 0.1, [clear(v)], CFG);
  assert.equal(d.how, 'locked');
  for (let i = 2; i < 12; i++) tr.decide(t0 + i * 0.1, [clear(v)], CFG);
  return tr;
}

test('locks on after two consistent frames', () => {
  const tr = new DisplayTracker();
  assert.equal(tr.decide(0, [clear(20050)], CFG).how, 'locking');
  const d = tr.decide(0.1, [clear(20050)], CFG);
  assert.equal(d.value, 20050);
  assert.equal(d.how, 'locked');
});

test('normal jitter inside the band is accepted', () => {
  const tr = locked();
  for (const v of [20100, 20000, 20050, 20150]) assert.equal(tr.decide(1.5, [clear(v)], CFG).how, 'ok');
});

test('a single far-off reading (20050 -> 10050) is not believed', () => {
  const tr = locked();
  const d = tr.decide(1.3, [clear(10050)], CFG);
  assert.equal(d.value, null);
  assert.equal(d.how, 'jump-pending');
  assert.equal(tr.decide(1.4, [clear(20050)], CFG).how, 'ok');
  // and the pending jump was forgotten
  assert.equal(tr.decide(1.5, [clear(10050)], CFG).how, 'jump-pending');
});

test('a genuine drop (crucible touching the cell) is accepted after 3 frames', () => {
  const tr = locked();
  assert.equal(tr.decide(1.3, [clear(19000)], CFG).value, null);
  assert.equal(tr.decide(1.4, [clear(18950)], CFG).value, null);
  const d = tr.decide(1.5, [clear(19000)], CFG);
  assert.equal(d.how, 'jump-accepted');
  assert.equal(d.value, 19000);
  assert.equal(tr.decide(1.6, [clear(19050)], CFG).how, 'ok');
});

test('an upward jump above anything seen must persist for 3 s', () => {
  const tr = locked();
  let t = 1.3, d;
  for (; t < 4.0; t += 0.1) {
    d = tr.decide(t, [clear(28050)], CFG);
    if (t < 4.2) assert.equal(d.value, null, `accepted too early at ${t}`);
  }
  for (; t < 4.6; t += 0.1) d = tr.decide(t, [clear(28050)], CFG);
  assert.equal(d.value, 28050);
});

test('an ambiguous frame is resolved by the prior (17200: 7 vs 9)', () => {
  const tr = locked(0, 17200);
  // second digit looks slightly more like a 9 than a 7; the strict reader refused it
  const lat = lattice('19200', { 1: { 7: 1.0, 9: 0.9 } });
  const d = tr.decide(1.3, [unread(lat)], CFG);
  assert.equal(d.how, 'prior');
  assert.equal(d.value, 17200);
});

test('a clear reading one segment away from the prediction is held, not rewritten', () => {
  const tr = locked(0, 19950);
  // genuine drop to 18950: "8" vs "9" is a single segment, but the reading was clear
  const d = tr.decide(1.3, [clear(18950)], CFG);
  assert.equal(d.value, null);
  assert.equal(d.how, 'jump-pending');
});

test('no prior rescue while a jump is pending', () => {
  const tr = locked(0, 17200);
  tr.decide(1.3, [clear(16200)], CFG); // possible genuine change
  const d = tr.decide(1.4, [unread(lattice('19200', { 1: { 7: 1.0, 9: 0.9 } }))], CFG);
  assert.equal(d.value, null);
});

test('an ambiguity between two values inside the band is not settled by guessing', () => {
  const tr = locked(0, 14700);
  // third digit could be a 6 or an 8 (one faint segment): 14600 and 14800 are both plausible
  const d = tr.decide(1.3, [unread(lattice('14600', { 2: { 6: 0.9, 8: 1.0 } }))], CFG);
  assert.equal(d.value, null);
});

test('a frame that clearly shows other digits is not forced to fit', () => {
  const tr = locked(0, 20050);
  const d = tr.decide(1.3, [unread(lattice('13550'))], CFG);
  assert.equal(d.value, null);
});

test('history goes stale after a long gap and has to lock on again', () => {
  const tr = locked();
  assert.equal(tr.decide(20, [clear(21000)], CFG).how, 'locking');
});

test('bestInBand picks the cheapest value near the prediction', () => {
  const b = bestInBand(lattice('20150'), { value: 20100, band: 150 }, CFG);
  assert.equal(b.v, 20150);
  assert.equal(b.inBand, true);
  assert.ok(Math.abs(b.excess) < 1e-9);
});

test('a better fit just outside the band blocks the rescue', () => {
  const tr = locked(0, 14550); // band 14400..14700
  // digits clearly say 1480? (last digit unclear): 14800 is just outside the band, 14600 inside
  const lat = lattice('14800', { 4: { 0: 1.4 }, 2: { 6: 1.1 } });
  const d = tr.decide(1.3, [unread(lat)], CFG);
  assert.equal(d.value, null);
});
