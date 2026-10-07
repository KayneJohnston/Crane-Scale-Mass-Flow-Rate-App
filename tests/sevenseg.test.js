import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderDisplay } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { readDigits, validateReading, expectedDigits } from '../js/vision/sevenseg.js';
import { randomScene } from '../tools/vision-eval.mjs';

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
