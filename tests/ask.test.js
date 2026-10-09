import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isUnclear, AskPolicy, askChoices, digitParts } from '../js/ask.js';

const box = { x: 0, y: 0, w: 300, h: 80 };
const unread = { ok: false, located: box, how: 'unread', reason: 'unknown-glyph' };
const clear = { ok: true, located: box, how: 'ok', value: 21800 };

test('which readings the person could help with', () => {
  assert.equal(isUnclear(unread), true);
  assert.equal(isUnclear({ ...unread, how: 'jump-pending', reason: 'jump-pending' }), true);
  assert.equal(isUnclear({ ...unread, how: 'digit-slip', reason: 'digit-slip' }), true);
  assert.equal(isUnclear(clear), false);
  assert.equal(isUnclear({ ok: true, located: box, how: 'prior', value: 21800 }), false); // the app gave a value
  assert.equal(isUnclear({ ok: false, located: null, reason: 'not-found' }), false); // re-aim instead
  assert.equal(isUnclear({ ok: false, located: box, reason: 'edge' }), false);
  assert.equal(isUnclear({ ok: false, located: box, reason: 'small' }), false);
});

test('asks after 3 s without a value, never when not allowed', () => {
  const P = new AskPolicy();
  assert.equal(P.frame(unread, 10), false);
  assert.equal(P.frame(unread, 12.9), false);
  assert.equal(P.frame(clear, 12.95), false); // a value: start counting again
  assert.equal(P.frame(unread, 13), false);
  assert.equal(P.frame(unread, 15.9), false);
  assert.equal(P.frame(unread, 16), true);
  assert.equal(P.frame(unread, 16.1, false), false);
});

test('quiet after an answer, longer after Not now, longer each time questions go unanswered', () => {
  const P = new AskPolicy();
  const askAt = (t0) => { for (let t = t0; t < t0 + 1000; t += 0.5) if (P.frame(unread, t)) return t; return null; };
  P.frame(unread, 0);
  assert.equal(askAt(0), 3);
  P.answered(3);
  assert.equal(askAt(3.5), 18); // 15 s quiet (the display stayed unclear all along)
  P.notNow(18);
  assert.equal(askAt(18.5), 78);
  const gaps = [];
  let t = 78;
  for (let i = 0; i < 5; i++) {
    P.timedOut(t + 12);
    const next = askAt(t + 12.5);
    gaps.push(next - (t + 12));
    t = next;
  }
  assert.deepEqual(gaps, [30, 60, 120, 300, 300]);
  P.answered(t);
  P.timedOut(t + 20);
  assert.equal(askAt(t + 20.5) - (t + 20), 30); // an answer starts the back-off afresh
});

test('the values offered: most probable first, then the expected value and neighbours, low to high', () => {
  const cfg = { stepKg: 50, minKg: 1000, maxKg: 40000 };
  const res = { ...unread, candidates: [{ v: 21800, p: 0.6 }, { v: 21700, p: 0.3 }, { v: 21900, p: 0.01 }], pred: { value: 21812, band: 150 } };
  assert.deepEqual(askChoices(res, cfg), [21700, 21750, 21800]);
  // a picture that says little (a long spell without readings, a digit half hidden):
  // the expected value and its neighbours
  const vague = { ...unread, candidates: [{ v: 18300, p: 0.25 }, { v: 18700, p: 0.2 }, { v: 18200, p: 0.15 }], pred: { value: 18190, band: 600 } };
  assert.deepEqual(askChoices(vague, cfg), [18150, 18200, 18250]);
  // a clear reading that was not believed (a jump being checked) is offered too
  const jump = { ...unread, how: 'jump-pending', strict: 19050, candidates: [{ v: 20050, p: 0.9 }], pred: { value: 20050, band: 150 } };
  assert.deepEqual(askChoices(jump, cfg), [19050, 20000, 20050]);
  // nothing known but a value to start from
  assert.deepEqual(askChoices({ ...unread }, cfg, { fallback: 3050 }), [3000, 3050, 3100]);
  assert.deepEqual(askChoices({ ...unread }, cfg), []);
  // correcting: the value shown first
  assert.deepEqual(askChoices({ ...clear, value: 21850, candidates: [{ v: 21850, p: 1 }] }, cfg, { correct: true }), [21800, 21850, 21900]);
});

test('the digits that differ are marked', () => {
  const parts = digitParts([21700, 21800, 21900]);
  assert.deepEqual(parts[1], [{ t: '21,', hi: false }, { t: '8', hi: true }, { t: '00', hi: false }]);
  const p2 = digitParts([21750, 21800]);
  assert.deepEqual(p2[0], [{ t: '21,', hi: false }, { t: '75', hi: true }, { t: '0', hi: false }]);
  const p3 = digitParts([9950, 10000]);
  assert.deepEqual(p3.map((p) => p.map((x) => x.t).join('')), ['9,950', '10,000']);
  assert.ok(p3.flat().every((x) => !x.hi)); // nearly every digit differs: none marked
  assert.ok(digitParts([17950, 18000, 18050]).flat().every((x) => !x.hi));
});
