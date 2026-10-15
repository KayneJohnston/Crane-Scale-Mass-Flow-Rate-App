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

// --------------------------------------------- pot changes are not touches --

// A crucible filled from three pots (100 s pot changes), run frame by frame through a
// fresh engine. lost: the display out of view while the crane moves; frame(sim, t):
// what the camera reads instead of the simulator (or undefined).
function crucible(seed, simOpts = {}, { lost = false, frame = null } = {}) {
  const sim = new TapSimulator({ seed, startMass: 16000, taps: [{ mass: 3500 }, { mass: 3500, rate0: 900 }, { mass: 2000, rate0: 800 }], gapSec: 100, ...simOpts });
  const moving = lost ? sim.tapList.slice(0, -1).map((tp) => [tp.end + 5, tp.end + 65]) : [];
  const ended = [];
  const eng = new TapEngine({}, { onSessionEnd: (s) => ended.push(s) });
  for (let t = 0; t < sim.duration + 5; t += 0.1) {
    const f = moving.some(([a, b]) => t >= a && t < b) ? { value: null } : frame?.(sim, t) ?? sim.frame(t);
    eng.pushFrame(t, W0 + t * 1000, f.value, f.conf ?? 1);
  }
  if (eng.sess) ended.push(eng.endSession('manual'));
  return { sim, eng, ended };
}

test('a pot change is not a touch: the weight settles lower when the vacuum is released', () => {
  // At the end of each pot the metal in the tapping tube goes back to the pot, and the
  // reading stays 150-300 kg lower while the crane moves to the next one (in view here).
  // On a real recording that showed as touches of 40 s and 3 min, and a recording could
  // end after a minute of one.
  for (const [seed, column] of [[1, 150], [2, 250], [3, 300]]) {
    const { sim, ended } = crucible(seed, { column, touches: 0 });
    const tag = `seed ${seed}, ${column} kg in the tube`;
    assert.equal(ended.length, 1, tag);
    const s = ended[0];
    assert.equal(s.endReason, 'stall', tag);
    assert.equal(s.touchCount, 0, tag);
    assert.ok(!s.events.some((e) => e.type === 'touch'), tag);
    // the readings while the crane moves are the weight, not rejected
    const T0 = (s.wall0 - W0) / 1000;
    const moving = s.meas.filter((r) => sim.tapList.slice(0, -1).some((tp) => r.t + T0 > tp.end + 3 && r.t + T0 < tp.end + 60));
    const low = moving.filter((r) => r.f === FLAG_CODES.low).length;
    assert.ok(moving.length > 150 && low / moving.length < 0.05, `${tag}: ${low} of ${moving.length} rejected`);
    assert.equal(analyseSession(s).segments.length, 3, tag);
  }
});

test('touches are found at the same time, and none invented', () => {
  // the simulator's touches (300-1500 kg, 3-9 s), also with the metal in the tube going
  // back at each pot change and the display lost while moving: touches that overlap
  // count as one
  for (const [seed, column, lost] of [[4, 0, false], [5, 200, false], [6, 300, true]]) {
    const { sim, ended } = crucible(seed, { column }, { lost });
    const s = ended[0], T0 = (s.wall0 - W0) / 1000;
    const tag = `seed ${seed}, ${column} kg in the tube${lost ? ', display lost while moving' : ''}`;
    assert.equal(ended.length, 1, tag);
    const found = s.events.filter((e) => e.type === 'touch-end').map((e) => [e.t + T0 - e.dur, e.t + T0]);
    const real = sim.touches.map((T) => [T.start, T.start + T.dur]);
    for (const [a, b] of found) assert.ok(real.some(([x, y]) => a <= y + 2 && b >= x - 1), `${tag}: a touch at ${a.toFixed(0)}-${b.toFixed(0)} s that wasn't`);
    for (const [x, y] of real) assert.ok(found.some(([a, b]) => a <= y + 2 && b >= x - 1), `${tag}: the touch at ${x.toFixed(0)}-${y.toFixed(0)} s missed`);
    assert.equal(s.touchCount, found.length, tag);
  }
});

test('a long touch on something solid is a touch, although the reading holds steady', () => {
  // Resting on the cell, the reading stays put while metal flows in, then jumps up when
  // the crucible is lifted. For the first 30 s it looks like a pot change.
  for (const seed of [1, 2]) {
    const { sim, ended } = runSim(seed, { touches: 1, touchHold: true, touchDepth: [300, 300], touchDur: [30, 30] });
    const s = ended[0];
    assert.equal(ended.length, 1);
    assert.equal(s.touchCount, 1, `seed ${seed}`);
    const e = s.events.find((x) => x.type === 'touch-end');
    assert.ok(Math.abs(e.dur - 30) < 3, `seed ${seed}: ${e.dur} s`);
    const a = analyseSession(s);
    assert.equal(a.segments.length, 1, `seed ${seed}`);
    assert.ok(Math.abs(a.segments[0].massKg - 3600) < 80, `seed ${seed}: mass ${a.segments[0].massKg}`);
    assert.ok(Math.abs(a.segments[0].avgKgMin - sim.trueAvgRate) / sim.trueAvgRate < 0.03, `seed ${seed}: avg ${a.segments[0].avgKgMin} vs ${sim.trueAvgRate}`);
  }
});

test('back in view with a few readings far too high: the readings after them are no touch', () => {
  // From a real recording: back in view after the crane moved to the next pot, the first
  // 4 s of readings were ~800 kg too high, and the minute of right ones after them was
  // taken for a touch (one more second and it would have ended the recording).
  for (const seed of [1, 2, 3]) {
    let back = null;
    const { sim, ended } = crucible(seed, { touches: 0 }, {
      lost: true,
      frame: (sim, t) => {
        back ??= sim.tapList[0].end + 65;
        if (t >= back && t < back + 4) return { value: sim.displayValue(t) + 800 };
      },
    });
    const s = ended[0];
    assert.equal(ended.length, 1, `seed ${seed}`);
    assert.equal(s.touchCount, 0, `seed ${seed}: ${JSON.stringify(s.events.filter((e) => e.type === 'touch-end'))}`);
    const a = analyseSession(s);
    assert.equal(a.segments.length, 3, `seed ${seed}`);
    a.segments.forEach((g, i) => assert.ok(Math.abs(g.massKg - sim.tapList[i].mass) < 100, `seed ${seed}, pot ${i + 1}: ${g.massKg} kg`));
  }
});

test('a touch just after the display is back in view is still a touch', () => {
  // the other way round from the readings far too high: the right ones first, then a
  // touch - while metal flowed during the spell out of view (mid-tap), or not (a pot change)
  for (const [seed, midTap, delay, depth] of [[4, true, 2, 500], [5, true, 4, 400], [2, false, 3, 300]]) {
    let g0, g1;
    const { sim, ended } = crucible(seed, { touches: 0 }, {
      frame: (sim, t) => {
        const tp = sim.tapList[0];
        if (g0 == null) [g0, g1] = midTap ? [tp.start + 120, tp.start + 160] : [tp.end + 5, tp.end + 65];
        if (t >= g0 && t < g1) return { value: null };
        if (t >= g1 + delay && t < g1 + delay + 6) return { value: sim.frame(t).value == null ? null : sim.displayValue(t) - depth };
      },
    });
    const s = ended[0], T0 = (s.wall0 - W0) / 1000, tag = `seed ${seed}, ${depth} kg ${delay} s after back in view${midTap ? ', mid-tap' : ''}`;
    assert.equal(ended.length, 1, tag);
    const found = s.events.filter((e) => e.type === 'touch-end').map((e) => [e.t + T0 - e.dur, e.t + T0]);
    assert.equal(found.length, 1, `${tag}: ${JSON.stringify(found)}`);
    assert.ok(found[0][0] <= g1 + delay + 6 && found[0][1] >= g1 + delay, `${tag}: ${found[0].map((x) => x.toFixed(0))}`);
    const a = analyseSession(s);
    assert.equal(a.segments.length, 3, tag);
    a.segments.forEach((g, i) => assert.ok(Math.abs(g.massKg - sim.tapList[i].mass) < 100, `${tag}, pot ${i + 1}: ${g.massKg} kg`));
  }
});

test('a touch is counted once when the flow restarts and its readings are judged again', () => {
  // From a real recording: a touch while the metal had stopped, then the flow found to
  // have resumed from before it - the touch was counted twice
  const sim = new TapSimulator({ seed: 3, startMass: 16000, taps: [{ mass: 2000 }, { mass: 2000 }], gapSec: 70, touches: 0 });
  const e1 = sim.tapList[0].end;
  const eng = new TapEngine({});
  for (let t = 0; t < e1 + 45; t += 0.1) {
    const f = sim.frame(t);
    eng.pushFrame(t, W0 + t * 1000, f.value == null || t < e1 + 30 || t > e1 + 33 ? f.value : f.value - 400, 1);
  }
  const S = eng.sess;
  assert.ok(S && !S.flowing, 'the flow has stopped');
  assert.equal(S.touchCount, 1);
  eng.flowStart(e1 + 20 - S.T0, { a: eng.levelAt(e1 + 20 - S.T0) ?? S.kf.m, b: 0, seB: 1 });
  assert.equal(S.touchCount, 1);
  assert.equal(S.events.filter((e) => e.type === 'touch-end').length, 1);
  assert.equal(S.events.filter((e) => e.type === 'touch').length, 1);
});

test('a crucible set down after the last pot still ends the recording', () => {
  const { ended } = crucible(1, { touches: 0, taps: [{ mass: 3000 }] }, {
    frame: (sim, t) => (t > sim.tapList[0].end + 30 ? { value: sim.displayValue(t) - 6000 } : undefined),
  });
  assert.equal(ended.length, 1);
  assert.equal(ended[0].endReason, 'low');
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

// A saved session as the engine leaves it (readings every 0.5 s on a 50 kg display;
// flag 1 accepted, 3 a touch), for the after-tap analysis on its own.
function savedSession(dur, weight, seen = () => true, flag = () => 1) {
  const meas = [];
  for (let t = 0; t <= dur; t += 0.5) if (seen(t)) meas.push({ t, z: Math.floor(weight(t) / 50) * 50, n: 5, f: flag(t) });
  return { id: 'x', duration: dur, meas, config: { targetKgMin: 600, tolPct: 10, stepKg: 50 }, events: [], noiseSigma: 15 };
}
const ramp = (t0, t1, kgMin) => (t) => (Math.max(0, Math.min(t, t1) - t0) * kgMin) / 60;

test('a tap whose end was out of view still counts', () => {
  // From a real recording: the display went out of view near the end of a tap and came
  // back with the weight settled. The level after the tap is the one it is next seen at
  // (the metal tapped meanwhile counts), and the tap ends when that would have flowed.
  const w = (t) => 19000 + ramp(60, 320, 600)(t);
  for (const [what, flag] of [['settled', () => 1], ['settled, then resting on something', (t) => (t >= 345 ? 3 : 1)]]) {
    const a = analyseSession(savedSession(500, (t) => w(t) - (what !== 'settled' && t >= 345 ? 250 : 0), (t) => t < 300 || t >= 340, flag));
    assert.equal(a.segments.length, 1, what);
    const g = a.segments[0];
    assert.equal(g.openEnd, false, what);
    assert.ok(Math.abs(g.massKg - 2600) <= 100, `${what}: mass ${g.massKg}`);
    assert.ok(Math.abs(g.end - 320) <= 15, `${what}: end ${g.end}`);
    assert.ok(Math.abs(g.avgKgMin - 600) <= 30, `${what}: avg ${g.avgKgMin}`);
  }
  // Not seen again (the recording ended): up to the last reading. (The level after the
  // tap once came from no readings at all, and the total was blank.)
  const b = analyseSession(savedSession(330, w, (t) => t < 300));
  assert.equal(b.segments.length, 1);
  const h = b.segments[0];
  assert.equal(h.openEnd, true);
  assert.ok(h.end <= 300, `ends at the last reading (${h.end})`);
  assert.ok(Math.abs(h.massKg - 2400) <= 100, `mass ${h.massKg}`);
  assert.ok(Math.abs(h.avgKgMin - 600) <= 30, `avg ${h.avgKgMin}`);
  assert.ok(Number.isFinite(b.totals.massKg) && Number.isFinite(b.totals.avgKgMin));
});

test('taps never overlap, so no metal is counted twice', () => {
  // From a real recording: a slow start, the display out of view, then the full flow.
  // The second tap was searched for from where the first one's rise had seemed to end,
  // before that end was refined past it: 134 kg counted in both.
  for (const slow of [120, 180]) {
    const truth = ramp(25, 90, slow)(560) + ramp(90, 560, 430)(560);
    const s = savedSession(650, (t) => 17550 + ramp(25, 90, slow)(t) + ramp(90, 560, 430)(t), (t) => t < 90 || t >= 125);
    const a = analyseSession(s);
    for (let i = 1; i < a.segments.length; i++) assert.ok(a.segments[i].onset >= a.segments[i - 1].end, `slow ${slow}: tap ${i + 1} starts before tap ${i} ends`);
    assert.ok(Math.abs(a.totals.massKg - truth) <= 100, `slow ${slow}: ${a.totals.massKg} kg vs ${Math.round(truth)}`);
  }
});
