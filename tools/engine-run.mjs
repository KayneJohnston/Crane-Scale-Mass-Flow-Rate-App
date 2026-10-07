// Run the simulator through the engine and print a summary.
//   node tools/engine-run.mjs [seed] [--verbose]
import { TapSimulator } from '../js/analysis/sim.js';
import { TapEngine } from '../js/analysis/engine.js';

export function runSim(seed, simOpts = {}, engCfg = {}, fps = 10) {
  const sim = new TapSimulator({ seed, ...simOpts });
  const ended = [];
  const events = [];
  const eng = new TapEngine(engCfg, { onSessionEnd: (s) => ended.push(s), onEvent: (e) => events.push(e) });
  const trace = [];
  const wall0 = Date.UTC(2026, 9, 7, 8, 0, 0);
  for (let t = 0; t < sim.duration + 5; t += 1 / fps) {
    const f = sim.frame(t);
    eng.pushFrame(t, wall0 + t * 1000, f.value, f.conf);
    if (Math.abs(t * 2 - Math.round(t * 2)) < 1e-6) {
      const s = eng.snapshot(t);
      if (s.session?.main?.rate != null) trace.push({ t, est: s.session.main.rate, sd: s.session.main.sd, truth: sim.trueRate(t - 0) });
    }
  }
  return { sim, eng, ended, events, trace };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = +(process.argv[2] || 1);
  const { sim, ended, events, trace } = runSim(seed);
  console.log(`sim: start ${sim.startMass} tap ${sim.tapStart.toFixed(1)}..${sim.tapEnd.toFixed(1)} s avg ${sim.trueAvgRate.toFixed(0)} kg/min touches ${sim.touches.map((t) => `${t.start.toFixed(0)}s/${t.dur.toFixed(1)}s/-${t.depth.toFixed(0)}`).join(', ')}`);
  console.log('events:', events.map((e) => `${e.type}@${e.t}${e.onset != null ? ' onset=' + e.onset : ''}${e.end != null ? ' end=' + e.end : ''}${e.kind ? ' ' + e.kind : ''}${e.reason ? ' ' + e.reason : ''}`).join(' | '));
  for (const s of ended) {
    console.log(`session ${s.id} start ${s.startReason} end ${s.endReason} dur ${s.duration}s segs ${JSON.stringify(s.segments)} touches ${s.touchCount} sigma ${s.noiseSigma}`);
  }
  // tracking error of the live (Kalman) rate after warm-up, excluding touches
  const errs = trace.filter((p) => !sim.inTouch(p.t));
  const rel = errs.map((p) => (p.est - p.truth) / p.truth).filter((x) => Number.isFinite(x));
  const rmse = Math.sqrt(rel.reduce((a, x) => a + x * x, 0) / rel.length);
  const meanSd = errs.reduce((a, p) => a + p.sd, 0) / errs.length;
  console.log(`live KF rate: n=${rel.length} rel RMSE ${(100 * rmse).toFixed(1)}% mean bias ${(100 * rel.reduce((a, x) => a + x, 0) / rel.length).toFixed(1)}% mean reported sd ${meanSd.toFixed(0)} kg/min`);
  if (process.argv.includes('--verbose')) for (const p of trace.filter((_, i) => i % 10 === 0)) console.log(p.t.toFixed(0), p.truth.toFixed(0), p.est.toFixed(0), '±', (1.645 * p.sd).toFixed(0));
}
