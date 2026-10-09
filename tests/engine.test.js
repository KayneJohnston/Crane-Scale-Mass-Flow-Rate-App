import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TapSimulator } from '../js/analysis/sim.js';
import { TapEngine, FLAG_CODES, ENGINE_VERSION, reprocessSession } from '../js/analysis/engine.js';
import { analyseSession } from '../js/analysis/offline.js';
import { runSim } from '../tools/engine-run.mjs';

const W0 = Date.UTC(2026, 9, 7, 8, 0, 0);

test('auto start, touch rejection, flow stop and auto end on a simulated tap', () => {
  const { sim, eng, ended, events, trace } = runSim(4);
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
  // the session ends when the weight hasn't risen for stallSec (3 min)
  const after = s.duration + T0 - sim.tapEnd;
  assert.ok(after > eng.cfg.stallSec - 20 && after < eng.cfg.stallSec + 20, `ended ${after} s after the tap`);
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

test('after the tap, the rate curve follows the true rate without lag', () => {
  // the saved tap's curve (two-pass smoother) against the live filter, over the whole tap
  let se = 0, seLive = 0, n = 0, inBand = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    const { sim, ended, trace } = runSim(seed);
    const s = ended[0];
    const T0 = (s.wall0 - W0) / 1000;
    const a = analyseSession(s);
    const live = new Map(trace.map((p) => [Math.round(p.t * 2), p.est]));
    a.smooth.t.forEach((tc, i) => {
      const tt = T0 + tc;
      const k = Math.round(tt * 2);
      if (tt < sim.tapStart + 5 || tt > sim.tapEnd - 5 || sim.inTouch(tt) || !live.has(k)) return;
      const tr = sim.trueRate(tt);
      se += ((a.smooth.rate[i] - tr) / tr) ** 2; seLive += ((live.get(k) - tr) / tr) ** 2; n++;
      if (Math.abs(a.smooth.rate[i] - tr) <= a.smooth.ci[i]) inBand++;
    });
  }
  const rms = Math.sqrt(se / n), rmsLive = Math.sqrt(seLive / n);
  assert.ok(rms < 0.035 && rms < 0.6 * rmsLive, `curve ${(100 * rms).toFixed(1)}% vs live ${(100 * rmsLive).toFixed(1)}%`);
  assert.ok(inBand / n > 0.85, `90% band covers ${(100 * inBand / n).toFixed(0)}%`);
});

test('a crucible filled from two pots gives one session with two taps', () => {
  const { sim, ended } = runSim(6, { taps: [{ mass: 3600 }, { mass: 3300, rate0: 700, rateEnd: 580 }], gapSec: 60 });
  assert.equal(ended.length, 1);
  const a = analyseSession(ended[0]);
  assert.equal(a.segments.length, 2);
  assert.ok(Math.abs(a.segments[1].massKg - 3300) < 100, `mass2 ${a.segments[1].massKg}`);
  assert.ok(Math.abs(a.segments[1].avgKgMin - sim.avgRateOf(1)) / sim.avgRateOf(1) < 0.04);
});

test('a standard crucible (three pots, 1.5-2.5 min pot changes, display lost while moving) stays one session', () => {
  // ~16 t empty, then 3.5 t, 3.5 t and 2 t. Each pot change: the crane moves (~1 min,
  // display out of view) and the vacuum builds up before metal flows again. The 150 s
  // and 90 s cases once ended the recording (the filter ran on across the blind minute,
  // so the unchanged weight looked like a touch) and found a phantom tap at the gap.
  for (const [seed, gapSec] of [[21, 120], [3, 150], [4, 90]]) {
    const sim = new TapSimulator({ seed, startMass: 16000, taps: [{ mass: 3500 }, { mass: 3500, rate0: 900 }, { mass: 2000, rate0: 800 }], gapSec });
    const moving = sim.tapList.slice(0, -1).map((tp) => [tp.end + 5, tp.end + 65]);
    const ended = [];
    const eng = new TapEngine({}, { onSessionEnd: (s) => ended.push(s) });
    for (let t = 0; t < sim.duration + 5; t += 0.1) {
      const f = moving.some(([a, b]) => t >= a && t < b) ? { value: null } : sim.frame(t);
      eng.pushFrame(t, W0 + t * 1000, f.value, f.conf);
    }
    const tag = `seed ${seed}, ${gapSec} s pot changes`;
    assert.equal(ended.length, 1, tag);
    assert.equal(ended[0].endReason, 'stall', tag);
    const a = analyseSession(ended[0]);
    assert.equal(a.segments.length, 3, tag);
    a.segments.forEach((g, i) => {
      assert.ok(Math.abs(g.massKg - sim.tapList[i].mass) < 100, `${tag}, pot ${i + 1}: ${g.massKg} kg`);
      assert.ok(Math.abs(g.avgKgMin - sim.avgRateOf(i)) / sim.avgRateOf(i) < 0.04, `${tag}, pot ${i + 1}: ${g.avgKgMin} vs ${sim.avgRateOf(i)} kg/min`);
    });
  }
});

test('a slow tap on a steady display that holds its value for seconds (as on the real scale)', () => {
  // From a real recording: no flicker, each value held for up to ~15 s, and a tap that
  // started at ~250 kg/min. The display then sits on one value for 10-15 s while metal
  // flows. That once ended the flow, restarted the filter ~650 kg too low and rejected
  // a third of the readings as spikes, splitting one tap into two with 60% of the mass.
  const sim = new TapSimulator({ seed: 5, rate0: 250, rateEnd: 650, rateTau: 200, tapMass: 3000, noise: 0, swingAmp: 0, displayHold: [1, 12], touches: 0, misreadProb: 0, wander: 20 });
  const ended = [], events = [], shown = [];
  const eng = new TapEngine({}, { onSessionEnd: (s) => ended.push(s), onEvent: (e) => events.push(e) });
  for (let t = 0; t < sim.duration + 5; t += 0.1) {
    const f = sim.frame(t);
    eng.pushFrame(t, W0 + t * 1000, f.value, f.conf);
    if (eng.sess?.flowing && eng.sess.main?.status) shown.push({ t, status: eng.sess.main.status, truth: sim.trueRate(t) });
  }
  assert.equal(ended.length, 1);
  assert.equal(events.filter((e) => e.type === 'flow-stop').length, 1, 'the flow stopped once, at the end');
  const s = ended[0];
  const rejected = s.meas.filter((r) => r.f === FLAG_CODES.high).length / s.meas.length;
  assert.ok(rejected < 0.02, `${(100 * rejected).toFixed(0)}% of the readings rejected as too high`);
  const a = analyseSession(s);
  assert.equal(a.segments.length, 1);
  assert.ok(Math.abs(a.segments[0].massKg - 3000) < 100, `mass ${a.segments[0].massKg}`);
  assert.ok(Math.abs(a.segments[0].avgKgMin - sim.trueAvgRate) / sim.trueAvgRate < 0.05, `avg ${a.segments[0].avgKgMin} vs ${sim.trueAvgRate}`);
  // the slow start raises "too slow", not "flow dropping"
  const slowStart = shown.filter((p) => p.truth < 350 && p.t > sim.tapStart + 45 && p.t < sim.tapEnd);
  const tooSlow = slowStart.filter((p) => p.status === 'slow').length / slowStart.length;
  assert.ok(slowStart.length > 100 && tooSlow > 0.6, `"too slow" shown ${(100 * tooSlow).toFixed(0)}% of the slow start`);
});

test('the engine tells the reader where to expect the weight', () => {
  // around the established weight, widening with the time since the value last moved
  // (a display that holds for seconds, a blind spell); never during a touch
  for (const opts of [{}, { displayHold: [1, 12], noise: 0, swingAmp: 0 }]) {
    let n = 0, inside = 0, halfW = 0, inTouch = 0;
    for (const seed of [1, 2, 3]) {
      const sim = new TapSimulator({ seed, ...opts });
      const eng = new TapEngine({});
      for (let t = 0; t < sim.duration; t += 0.1) {
        const blind = t > sim.tapStart + 60 && t < sim.tapStart + 72;
        eng.pushFrame(t, W0 + t * 1000, blind ? null : sim.frame(t).value);
        const e = eng.expectation(t + 0.1);
        if (e && eng.sess.touch) inTouch++;
        if (!e || sim.inTouch(t) || sim.inTouch(t + 1)) continue;
        const v = sim.displayValue(t + 0.1);
        n++; halfW += (e.hi - e.lo) / 2;
        if (v >= e.lo && v <= e.hi) inside++;
        assert.ok(e.high >= e.hi);
      }
      assert.equal(eng.expectation(sim.duration + eng.cfg.lostSec + 10), null);
    }
    assert.equal(inTouch, 0);
    assert.ok(n > 5000, `${n}`);
    assert.ok(inside / n > 0.995, `display inside the expected range ${(100 * inside / n).toFixed(2)}%`);
    assert.ok(halfW / n < 160, `mean half-width ${(halfW / n).toFixed(0)} kg`);
  }
});

test('a saved recording is re-run from its raw frames by the current engine', () => {
  const { ended } = runSim(3);
  const s = ended[0];
  const live = analyseSession(s);
  // as if an older engine had wrongly rejected every reading after the first minutes
  const old = { ...s, engineVersion: 1, meas: s.meas.map((r, i) => (i > 300 ? { ...r, f: FLAG_CODES.high } : r)) };
  const damaged = analyseSession(old).segments.reduce((m, g) => m + g.massKg, 0);
  assert.ok(damaged < live.segments[0].massKg - 500, `the damaged copy is wrong (${damaged} kg)`);
  const r = reprocessSession(old);
  assert.equal(r.engineVersion, ENGINE_VERSION);
  assert.equal(r.id, s.id);
  assert.ok(Math.abs(r.meas.length - s.meas.length) <= 3, `${r.meas.length} vs ${s.meas.length} readings`);
  const a = analyseSession(r);
  assert.equal(a.segments.length, 1);
  assert.ok(Math.abs(a.segments[0].massKg - live.segments[0].massKg) <= 50, `mass ${a.segments[0].massKg} vs ${live.segments[0].massKg}`);
  assert.ok(Math.abs(a.segments[0].avgKgMin - live.segments[0].avgKgMin) <= 15, `avg ${a.segments[0].avgKgMin} vs ${live.segments[0].avgKgMin}`);
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
