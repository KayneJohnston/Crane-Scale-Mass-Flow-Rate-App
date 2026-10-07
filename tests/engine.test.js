import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapSimulator } from '../js/analysis/sim.js';
import { TapEngine } from '../js/analysis/engine.js';
import { analyseSession } from '../js/analysis/offline.js';
import { runSim } from '../tools/engine-run.mjs';

const W0 = Date.UTC(2026, 9, 7, 8, 0, 0);

test('auto start, touch rejection, flow stop and auto end on a simulated tap', () => {
  const { sim, ended, events, trace } = runSim(4);
  assert.equal(ended.length, 1);
  const s = ended[0];
  assert.equal(s.startReason, 'auto');
  assert.equal(s.endReason, 'stall');
  const T0 = (s.wall0 - W0) / 1000;
  const seg = s.segments[0];
  assert.ok(Math.abs(seg.onset + T0 - sim.tapStart) < 4, `onset ${seg.onset + T0} vs ${sim.tapStart}`);
  assert.ok(Math.abs(seg.end + T0 - sim.tapEnd) < 6, `end ${seg.end + T0} vs ${sim.tapEnd}`);
  // both touch events detected, none invented
  assert.equal(events.filter((e) => e.type === 'touch').length, 2);
  // the session ends ~2 min after the weight stops rising
  assert.ok(s.duration + T0 - sim.tapEnd > 100 && s.duration + T0 - sim.tapEnd < 140);
  // live Kalman rate
  const errs = trace.filter((p) => !sim.inTouch(p.t) && p.truth > 100).map((p) => (p.est - p.truth) / p.truth);
  const rmse = Math.sqrt(errs.reduce((a, x) => a + x * x, 0) / errs.length);
  assert.ok(rmse < 0.1, `rmse ${rmse}`);
});

test('post-tap analysis recovers delivered mass and average rate', () => {
  for (const seed of [1, 2, 3]) {
    const { sim, ended } = runSim(seed);
    const a = analyseSession(ended[0]);
    assert.equal(a.segments.length, 1);
    const seg = a.segments[0];
    assert.ok(Math.abs(seg.massKg - 3600) < 80, `mass ${seg.massKg}`);
    assert.ok(Math.abs(seg.avgKgMin - sim.trueAvgRate) / sim.trueAvgRate < 0.03, `avg ${seg.avgKgMin} vs ${sim.trueAvgRate}`);
    assert.equal(seg.verdict, 'fast');
    assert.equal(seg.touches, 2);
  }
});

test('a crucible filled from two pots gives one session with two taps', () => {
  const { sim, ended } = runSim(6, { taps: [{ mass: 3600 }, { mass: 3300, rate0: 700, rateEnd: 580 }], gapSec: 60 });
  assert.equal(ended.length, 1);
  const a = analyseSession(ended[0]);
  assert.equal(a.segments.length, 2);
  assert.ok(Math.abs(a.segments[1].massKg - 3300) < 100, `mass2 ${a.segments[1].massKg}`);
  assert.ok(Math.abs(a.segments[1].avgKgMin - sim.avgRateOf(1)) / sim.avgRateOf(1) < 0.04);
});

test('robust to a camera that drops 30% of frames and misreads 3%', () => {
  const { sim, ended } = runSim(9, { dropProb: 0.3, misreadProb: 0.03 });
  assert.equal(ended.length, 1);
  const a = analyseSession(ended[0]);
  assert.equal(a.segments.length, 1);
  assert.ok(Math.abs(a.segments[0].avgKgMin - sim.trueAvgRate) / sim.trueAvgRate < 0.04);
});

test('no session starts on a steady (noisy) weight', () => {
  const sim = new TapSimulator({ seed: 12, tapMass: 1, rate0: 0, rateEnd: 0, touches: 0, idleBefore: 600 });
  const ended = [];
  const eng = new TapEngine({}, { onSessionEnd: (s) => ended.push(s) });
  for (let t = 0; t < 500; t += 0.1) { const f = sim.frame(t); eng.pushFrame(t, W0 + t * 1000, f.value, f.conf); }
  assert.equal(eng.sess, null);
  assert.equal(ended.length, 0);
});

test('session ends when the display is lost', () => {
  const sim = new TapSimulator({ seed: 3 });
  const ended = [];
  const eng = new TapEngine({ lostSec: 20 }, { onSessionEnd: (s) => ended.push(s) });
  for (let t = 0; t < 150; t += 0.1) { const f = sim.frame(t); eng.pushFrame(t, W0 + t * 1000, f.value, f.conf); }
  assert.ok(eng.sess, 'session running');
  for (let t = 150; t < 175; t += 0.1) eng.pushFrame(t, W0 + t * 1000, null, 0);
  assert.equal(ended.length, 1);
  assert.equal(ended[0].endReason, 'lost');
});

test('manual start and stop', () => {
  const eng = new TapEngine({ autoStart: false });
  for (let t = 0; t < 5; t += 0.1) eng.pushFrame(t, W0 + t * 1000, 20000, 1);
  const s = eng.startSession(5, 'manual');
  assert.ok(s);
  for (let t = 5; t < 20; t += 0.1) eng.pushFrame(t, W0 + t * 1000, 20000, 1);
  const out = eng.endSession('manual');
  assert.equal(out.startReason, 'manual');
  assert.equal(out.endReason, 'manual');
  assert.ok(out.meas.length > 20);
});

test('main indicator: too fast -> red down, on target -> green', () => {
  const fast = runSim(1).trace; // operator starts ~1050 kg/min
  assert.ok(fast.length > 0);
  const eng = new TapEngine();
  const sim = new TapSimulator({ seed: 21, rate0: 600, rateEnd: 600, wander: 10, touches: 0 });
  const statuses = new Set();
  for (let t = 0; t < 200; t += 0.1) {
    const f = sim.frame(t);
    eng.pushFrame(t, W0 + t * 1000, f.value, f.conf);
    const m = eng.snapshot(t).session?.main;
    if (m && t > 100) statuses.add(m.status);
  }
  assert.ok(statuses.has('ok'), [...statuses].join());
  assert.ok(!statuses.has('fast') && !statuses.has('slow'), [...statuses].join());
  const eng2 = new TapEngine();
  const sim2 = new TapSimulator({ seed: 22, rate0: 1100, rateEnd: 1100, wander: 10, touches: 0 });
  let last;
  for (let t = 0; t < 150; t += 0.1) { const f = sim2.frame(t); eng2.pushFrame(t, W0 + t * 1000, f.value, f.conf); last = eng2.snapshot(t).session?.main; }
  assert.equal(last.status, 'fast');
  assert.equal(last.certain, true);
});
