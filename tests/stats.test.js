import { test } from 'node:test';
import assert from 'node:assert/strict';
import { robustSlope, hingeOnset, hingeStop, secondDiffSigma, median, madSigma } from '../js/analysis/stats.js';
import { RateKF, rateVarToS } from '../js/analysis/kalman.js';
import { mulberry32 } from '../js/vision/render7seg.js';

const gauss = (r) => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
const q50 = (x) => Math.round(x / 50) * 50;

test('median / MAD', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.ok(Math.abs(madSigma([1, 2, 3, 4, 100]) - 1.4826) < 1e-9);
});

test('Theil–Sen slope survives 20% one-sided outliers (touch events)', () => {
  const r = mulberry32(3);
  const t = [], z = [];
  for (let i = 0; i < 120; i++) {
    t.push(i * 0.5);
    let v = 15000 + 10 * i * 0.5 + 40 * gauss(r);
    if (i >= 50 && i < 74) v -= 900; // 12 s touch
    z.push(q50(v));
  }
  const f = robustSlope(t, z);
  assert.ok(Math.abs(f.slope - 10) < 0.8, `slope ${f.slope}`);
  // least squares would be badly biased by the touch
  assert.ok(f.se > 0 && f.se < 1.5);
});

test('standard error is honest: ~90% of 90% intervals cover the truth', () => {
  const r = mulberry32(11);
  let cover = 0;
  const N = 300;
  for (let k = 0; k < N; k++) {
    const t = [], z = [];
    for (let i = 0; i < 120; i++) { t.push(i * 0.5); z.push(q50(20000 + 10 * t[i] + 35 * gauss(r))); }
    const f = robustSlope(t, z);
    if (Math.abs(f.slope - 10) <= 1.645 * f.se) cover++;
  }
  assert.ok(cover / N > 0.8 && cover / N < 0.99, `coverage ${cover / N}`);
});

test('hinge fits locate the start and end of a tap', () => {
  const r = mulberry32(5);
  const t = [], z = [];
  for (let i = 0; i < 400; i++) {
    const ti = i * 0.5;
    t.push(ti);
    const m = ti < 30 ? 14000 : ti < 170 ? 14000 + 10 * (ti - 30) : 15400;
    z.push(q50(m + 30 * gauss(r)));
  }
  const on = hingeOnset(t.slice(0, 160), z.slice(0, 160));
  assert.ok(Math.abs(on.tau - 30) < 2, `onset ${on.tau}`);
  assert.ok(Math.abs(on.b - 10) < 1);
  const off = hingeStop(t.slice(200), z.slice(200));
  assert.ok(Math.abs(off.tau - 170) < 2, `stop ${off.tau}`);
});

test('second-difference noise estimate', () => {
  const r = mulberry32(8);
  const t = [], z = [];
  for (let i = 0; i < 200; i++) { t.push(i * 0.5); z.push(20000 + 8 * i + 40 * gauss(r)); }
  const s = secondDiffSigma(t, z, 0, t.length);
  assert.ok(s > 32 && s < 48, `sigma ${s}`);
});

test('Kalman filter tracks a ramp from quantised noisy readings', () => {
  const r = mulberry32(2);
  const kf = new RateKF(rateVarToS(100));
  kf.init(0, 15000, 0, 2500, 100);
  for (let i = 1; i <= 240; i++) {
    const t = i * 0.5;
    kf.predict(t);
    kf.update(q50(15000 + 10 * t + 30 * gauss(r)), 30 * 30 + 208);
  }
  assert.ok(Math.abs(kf.q - 10) < 1.5, `rate ${kf.q}`);
  assert.ok(Math.sqrt(kf.Pqq) < 1.5);
});
