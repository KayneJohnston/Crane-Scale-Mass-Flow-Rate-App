import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplay } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { readDigits, validateReading, expectedDigits, decodeLattice } from '../js/vision/sevenseg.js';
import { randomScene, hotScene } from '../tools/vision-eval.mjs';

function scene(text, opts = {}, W = 640, H = 360) {
  const buf = new Uint8ClampedArray(W * H * 4);
  renderDisplay(buf, W, H, { text, digitH: 50, ...opts });
  return { buf, W, H };
}

test('reads every digit in clean renders (incl. displays without middle bars)', () => {
  for (const text of ['01234', '56789', '20050', '13000', '26000', '17000', '11111', '24950', '18850']) {
    const { buf, W, H } = scene(text);
    const r = readDigits(buf, W, H);
    assert.equal(r.ok, true, `${text}: ${r.reason}`);
    assert.equal(r.text, text);
  }
});

test('handles slant, rotation, small digits and an off-centre display', () => {
  const cases = [
    { text: '21350', slantDeg: 12, rotDeg: 0 },
    { text: '21350', slantDeg: 0, rotDeg: -6 },
    { text: '19700', slantDeg: 8, rotDeg: 5, digitH: 18 },
    { text: '14450', slantDeg: 5, rotDeg: 2, digitH: 22, cx: 120, cy: 300 },
  ];
  for (const c of cases) {
    const { buf, W, H } = scene(c.text, c);
    const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H });
    assert.equal(r.ok, true, `${JSON.stringify(c)}: ${r.reason}`);
    assert.equal(r.value, +c.text);
  }
});

test('random harsh scenes: high read rate and no wrong values', () => {
  let ok = 0, wrong = 0;
  const N = 120;
  for (let s = 1; s <= N; s++) {
    const { W, H, value, opts } = randomScene(1000 + s);
    const buf = new Uint8ClampedArray(W * H * 4);
    renderDisplay(buf, W, H, opts);
    const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H });
    if (r.ok && r.value === value) ok++;
    else if (r.ok) wrong++;
  }
  assert.equal(wrong, 0, 'a wrong reading is worse than no reading');
  assert.ok(ok / N >= 0.9, `read rate ${ok}/${N}`);
});

test('ignores indicator LEDs and decimal points next to the digits', () => {
  const W = 640, H = 360;
  const leds = [
    (g) => [{ x: g.cx + g.totalW / 2 + 6, y: g.cy - 18, r: 3.5, color: [255, 40, 30] }],
    (g) => [{ x: g.cx + g.totalW / 2 + 14, y: g.cy, r: 4, color: [255, 40, 30] }],
    (g) => [{ x: g.cx - g.totalW / 2 - 10, y: g.cy - 18, r: 4, color: [255, 40, 30] }],
  ];
  for (const led of leds) {
    const buf = new Uint8ClampedArray(W * H * 4);
    const g = renderDisplay(buf, W, H, { text: '20050', digitH: 50, slantDeg: 6 });
    renderDisplay(buf, W, H, { text: '20050', digitH: 50, slantDeg: 6, clutter: led(g) });
    const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H });
    assert.equal(r.value, 20050, r.reason);
  }
  const buf = new Uint8ClampedArray(W * H * 4);
  renderDisplay(buf, W, H, { text: '2005', digitH: 50, dp: 1 }); // "20.05" tonnes
  const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H }, { multiplier: 10 });
  assert.equal(r.value, 20050, r.reason);
});

test('rejects a display that is cut off by the frame edge', () => {
  const { buf, W, H } = scene('20050', { cx: 20, digitH: 60 });
  const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H });
  assert.equal(r.ok, false);
});

test('finds nothing in an empty dark frame or a frame with only glare', () => {
  const W = 320, H = 200;
  const buf = new Uint8ClampedArray(W * H * 4);
  renderDisplay(buf, W, H, { text: '', panel: false, glare: [{ x: 100, y: 80, r: 40, i: 220 }] });
  const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H });
  assert.equal(r.ok, false);
});

test('validation: digit count, range, 50 kg step', () => {
  const cfg = { minKg: 10000, maxKg: 30000, stepKg: 50, multiplier: 1 };
  assert.equal(expectedDigits(10000, 30000), 5);
  assert.equal(validateReading('20050', 1, cfg).ok, true);
  assert.equal(validateReading('2005', 1, cfg).why, 'digits');
  assert.equal(validateReading('40050', 1, cfg).why, 'range');
  assert.equal(validateReading('20030', 1, cfg).why, 'step');
  assert.equal(validateReading('2005', 1, { ...cfg, multiplier: 10 }).value, 20050);
});

const readScene = ({ W, H, opts }, cfg = {}) => {
  const buf = new Uint8ClampedArray(W * H * 4);
  renderDisplay(buf, W, H, opts);
  return readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H }, cfg);
};

test('over-exposed display (white cores in a red bloom, indicator LEDs): reads, never misreads', () => {
  let ok = 0, wrong = 0;
  const N = 40;
  for (let s = 1; s <= N; s++) {
    const sc = hotScene(500 + s);
    const r = readScene(sc);
    if (r.ok && r.value === sc.value) ok++;
    else if (r.ok) wrong++;
  }
  assert.equal(wrong, 0);
  assert.ok(ok / N >= 0.75, `read rate ${ok}/${N}`);
  // a 4-digit value leaves the first of the five cells blank
  for (const value of [3050, 9950, 25700]) {
    const r = readScene(hotScene(7, { value, digitH: 50 }));
    assert.equal(r.value, value, r.reason);
    assert.equal(r.mode, 'hot');
  }
});

test('a normally exposed red display is not read as an over-exposed one', () => {
  const { buf, W, H } = scene('17000', { glow: 0.45, gain: 1.2, lit: [255, 41, 24] });
  const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H }, { colorMode: 'hot' });
  assert.equal(r.ok, false);
  assert.equal(readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H }).value, 17000);
});

test('a leading 1 is never dropped (13050 is not read as 3050)', () => {
  // thick, blurred strokes: each half of the "1" is a short blob, like an indicator LED
  let wrong = 0, ok = 0;
  for (const text of ['13050', '16250', '19500', '14000']) {
    for (const thickRatio of [0.12, 0.16, 0.18]) {
      for (const blur of [0, 1.5]) {
        const { buf, W, H } = scene(text, { thickRatio, blur, glow: 0.4, gapRatio: 0.04, slantDeg: 5, digitH: 40 });
        const r = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H });
        if (r.ok && r.value === +text) ok++;
        else if (r.ok) wrong++;
      }
    }
  }
  assert.equal(wrong, 0);
  assert.ok(ok >= 20, `read ${ok}/24`);
});

test('constrained decoding settles ambiguous digits but never overrules a clear one', () => {
  const cfg = { minKg: 1000, maxKg: 40000, stepKg: 50, multiplier: 1 };
  const lat = (rows) => ({ n: rows.length, costs: rows.map((r) => Float64Array.from(r)) });
  const clear = (d) => Array.from({ length: 10 }, (_, k) => (k === d ? 0.2 : 2.5));
  // "3?50": the third digit looks a little more like a 3 than a 5 - but a 50 kg
  // display can only show 0 or 5 there
  const amb = clear(5); amb[3] = 1.0; amb[5] = 1.2;
  const d1 = decodeLattice(lat([clear(3), clear(0), amb, clear(0)]), cfg);
  assert.equal(d1.value, 3050);
  assert.ok(d1.maxDigitExcess <= 0.5 && d1.margin >= 0.8);
  // the last digit clearly shows an 8, which is impossible: the picture is not trusted
  const d2 = decodeLattice(lat([clear(2), clear(0), clear(8), clear(5), clear(8)]), cfg);
  assert.ok(d2.maxDigitExcess > 0.5);
  // two valid values fit equally well: no clear winner
  const six = clear(6); six[8] = 0.3;
  const d3 = decodeLattice(lat([clear(1), six, clear(0), clear(5), clear(0)]), cfg);
  assert.ok(d3.margin < 0.8);
});

test('scenes that once misread now read correctly or are refused', () => {
  // dropped leading/trailing digits (13050 -> 3050, 24500 -> 2450), glued "1"s,
  // a "3" read as "8" in an over-exposed glow, a "7" read as "1"
  const cases = [[525, true], [691, true], [9117, true], [9180, true], [9209, true], [9320, true],
    [35, true], [93, true], [190, true], [399, false], [667, false]];
  for (const [seed, hard] of cases) {
    const sc = randomScene(seed, hard);
    const r = readScene(sc);
    assert.ok(!r.ok || r.value === sc.value, `seed ${seed}: read ${r.value} for ${sc.value}`);
  }
});
