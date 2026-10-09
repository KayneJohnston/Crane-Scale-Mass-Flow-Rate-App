import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DisplayTracker, digitSlip, TRACK_DEFAULTS } from '../js/vision/tracker.js';
import { valuePosterior } from '../js/vision/posterior.js';
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

test('valuePosterior: the picture and the prediction combined into a probability per value', () => {
  const C = { ...TRACK_DEFAULTS, ...CFG };
  const b = valuePosterior(lattice('20150'), { value: 20100, band: 150 }, C);
  assert.equal(b.v, 20150);
  assert.ok(b.p > 0.999 && Math.abs(b.excess) < 1e-9 && b.sameLength);
  assert.ok(Math.abs(b.top.reduce((s, x) => s + x.p, 0) - 1) < 0.01);
  // an 8 that might be a 9: the picture alone can't tell 18000 from 19000 ...
  const lat = lattice('18000', { 1: { 8: 1.2, 9: 1.3 } });
  const alone = valuePosterior(lat, null, C);
  assert.ok(alone.p < 0.6, `picture alone ${alone.p}`);
  // ... the dead reckoning can
  const both = valuePosterior(lat, { value: 18000, band: 150 }, C);
  assert.equal(both.v, 18000);
  assert.ok(both.p > 0.995, `with the prediction ${both.p}`);
});

test('a better fit just outside the band blocks the rescue', () => {
  const tr = locked(0, 14550); // band 14400..14700
  // digits clearly say 1480? (last digit unclear): 14800 is just outside the band, 14600 inside
  const lat = lattice('14800', { 4: { 0: 1.4 }, 2: { 6: 1.1 } });
  const d = tr.decide(1.3, [unread(lat)], CFG);
  assert.equal(d.value, null);
});

// --------------------------------------------------- dropped or extra digits --

const WIDE = { ...CFG, minKg: 1000 };

function lockedAt(v, cfg = WIDE) {
  const tr = new DisplayTracker();
  for (let i = 0; i < 12; i++) tr.decide(i * 0.1, [clear(v)], cfg);
  return tr;
}

test('digitSlip: the expected value with a digit lost or added', () => {
  assert.equal(digitSlip(1700, 16900, 17100, WIDE), true); // a "0" lost
  assert.equal(digitSlip(7000, 16900, 17100, WIDE), true); // the "1" lost
  assert.equal(digitSlip(1900, 18950, 19050, WIDE), true);
  assert.equal(digitSlip(19950, 9900, 10000, WIDE), true); // an extra "1"
  assert.equal(digitSlip(17050, 16900, 17100, WIDE), false);
  assert.equal(digitSlip(12050, 19900, 20200, WIDE), false);
  assert.equal(digitSlip(3050, 16000, 20000, WIDE), false);
});

test('a reading with a digit lost (17000 -> 1700, 7000) is refused however often it repeats', () => {
  for (const slip of [1700, 7000]) {
    const tr = lockedAt(17000);
    for (let t = 1.2; t < 7; t += 0.1) {
      const d = tr.decide(t, [clear(slip)], WIDE);
      assert.equal(d.value, null, `${slip} accepted at ${t.toFixed(1)} s`);
      assert.equal(d.how, 'digit-slip');
    }
    assert.equal(tr.decide(7, [clear(17050)], WIDE).how, 'ok');
  }
});

test('an extra digit (9950 -> 19950) is refused too', () => {
  const tr = lockedAt(9950);
  for (let t = 1.2; t < 7; t += 0.1) assert.equal(tr.decide(t, [clear(19950)], WIDE).value, null);
});

test('a digit slip cannot take over once the history has gone stale', () => {
  const tr = lockedAt(17000);
  // nothing readable for 20 s, then the reader keeps losing the "1"
  for (let t = 21; t < 40; t += 0.1) assert.equal(tr.decide(t, [clear(7050)], WIDE).value, null, `locked onto 7050 at ${t.toFixed(1)} s`);
  // a clear reading of the real value locks on as usual
  tr.decide(40, [clear(17300)], WIDE);
  assert.equal(tr.decide(40.1, [clear(17300)], WIDE).how, 'locked');
});

test('the remembered level is forgotten after slipSec: a lasting new value locks on', () => {
  const tr = lockedAt(17000);
  tr.decide(70, [clear(1700)], WIDE);
  assert.equal(tr.decide(70.1, [clear(1700)], WIDE).how, 'locked');
});

test('a clear reading of the right value is taken when another colour mode lost a digit', () => {
  const tr = lockedAt(17000);
  const d = tr.decide(1.3, [clear(1700), clear(17000)], WIDE);
  assert.equal(d.how, 'ok');
  assert.equal(d.value, 17000);
});

test('a drop of more than maxDropKg must persist like an implausible jump', () => {
  const tr = locked(0, 20050);
  let t = 1.3, d;
  for (; t < 4.0; t += 0.1) {
    d = tr.decide(t, [clear(12050)], CFG);
    assert.equal(d.value, null, `accepted too early at ${t.toFixed(1)}`);
  }
  for (; t < 4.6; t += 0.1) d = tr.decide(t, [clear(12050)], CFG);
  assert.equal(d.value, 12050);
});

// ------------------------------------------- the tap engine's expectation --

// 18000 on the display, the 8 too glowing to make out on its own
const glowing8 = () => lattice('18000', { 1: { 8: 1.4, 9: 2.2, 0: 2.3, 6: 2.4 } });
const EXPECT = { lo: 17900, hi: 18150, level: 17950, high: 18700 };

test('with the engine\'s expectation, an unclear frame is resolved after the history went stale', () => {
  const without = locked(0, 17950);
  assert.equal(without.decide(20, [unread(glowing8())], CFG).value, null);
  const tr = locked(0, 17950);
  const d = tr.decide(20, [unread(glowing8())], CFG, tr.predict(20, CFG, EXPECT));
  assert.equal(d.how, 'prior');
  assert.equal(d.value, 18000);
  assert.equal(d.pred.external, true);
});

test('the expectation takes over from a band widened by unread frames', () => {
  const tr = locked(0, 17950);
  // 4 s without a reading: the own band has grown at the fastest pouring rate
  const own = tr.predict(5.2, CFG);
  assert.ok(own.band > 250 && !own.external);
  assert.equal(tr.decide(5.2, [unread(glowing8())], CFG).value, null);
  const p = tr.predict(5.2, CFG, EXPECT);
  assert.equal(p.external, true);
  assert.equal(tr.decide(5.2, [unread(glowing8())], CFG, p).value, 18000);
});

test('an unseen touch is not "corrected" up to the expected weight', () => {
  // the history went stale; meanwhile a touch pulled the display down to 16000, and the
  // picture says 6 rather than 8: 18000 is expected, but no longer probable enough
  const lat = lattice('16000', { 1: { 6: 0.6, 8: 1.4 } });
  const tr = locked(0, 17950);
  const d = tr.decide(20, [unread(lat)], CFG, tr.predict(20, CFG, EXPECT));
  assert.equal(d.value, null);
  assert.ok(d.near.p < 0.95, `${d.near.v}: ${d.near.p}`);
});

test('no more guessing after 20 s without one clear reading', () => {
  const tr = locked(0, 17950);
  let last = null;
  for (let t = 1.2; t < 30; t += 0.1) {
    const d = tr.decide(t, [unread(glowing8())], CFG, tr.predict(t, CFG, EXPECT));
    if (d.value != null) last = t;
  }
  assert.ok(last > 15 && last < 21.2, `last guess at ${last}`);
  assert.equal(tr.decide(30, [clear(18000)], CFG, tr.predict(30, CFG, EXPECT)).how, 'ok');
  assert.equal(tr.decide(30.1, [unread(glowing8())], CFG).how, 'prior');
});

test('a clear reading the engine expects is taken at once after a stale spell', () => {
  const tr = locked(0, 17950);
  const d = tr.decide(20, [clear(18050)], CFG, tr.predict(20, CFG, EXPECT));
  assert.equal(d.how, 'ok');
  assert.equal(d.value, 18050);
});

test('the expectation does not override readings that disagree with it (a touch)', () => {
  const tr = locked(0, 17950);
  for (const t of [1.3, 1.4, 1.5]) tr.decide(t, [clear(16000)], CFG); // the crucible rests on the cell
  const p = tr.predict(4, CFG, EXPECT);
  assert.ok(!p.external);
  assert.ok(Math.abs(p.level - 16000) < 1);
});

test('a digit lost after a touch is still recognised when the weight comes back', () => {
  const tr = lockedAt(20000);
  for (const t of [1.3, 1.4, 1.5]) tr.decide(t, [clear(19000)], WIDE); // touch: accepted as a drop
  for (let t = 1.6; t < 2; t += 0.1) tr.decide(t, [clear(19000)], WIDE);
  // nothing readable while the crucible is lifted off the cell, then the "0" drowns
  for (let t = 12; t < 20; t += 0.1) assert.equal(tr.decide(t, [clear(2050)], WIDE).value, null);
});

test('no guess between 21700 and 21800 when an over-exposed 8 looks more like a 7', () => {
  // per-digit costs measured on a real frame of "-2-1800." whose 8 lost its bottom bar
  const costs = [
    [3.2, 7.7, 0.7, 1.7, 4.4, 3.3, 3.1, 3.7, 2.2, 2.4],
    [4.0, 0.1, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0, 4.0],
    [3.4, 6.2, 3.2, 3.3, 3.4, 3.9, 3.9, 2.2, 3.4, 2.4],
    [0.5, 6.5, 3.4, 3.2, 3.6, 3.2, 2.5, 1.6, 1.5, 2.2],
    [0.2, 6.8, 3.1, 3.0, 3.9, 3.1, 2.2, 1.9, 1.2, 2.1],
  ].map((c) => Float64Array.from(c));
  const tr = locked(0, 21750);
  const p = tr.predict(20, CFG, { lo: 21650, hi: 21900, high: 21750 });
  const d = tr.decide(20, [unread({ n: 5, costs })], CFG, p);
  assert.equal(d.value, null);
});

