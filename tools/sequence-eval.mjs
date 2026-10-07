// Frame-sequence evaluation of the temporal tracker.
//   node tools/sequence-eval.mjs [sequences] [--hard] [--len seconds] [--fps n]
// Renders the display of a simulated tap (real-time jitter, touch drops, hand-held
// wobble) and reads every frame twice: independently, and with the tracker that
// uses the previous readings. Ground truth = the value the display shows.
import { renderDisplay } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { TapSimulator } from '../js/analysis/sim.js';
import { randomScene } from './vision-eval.mjs';

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
const nSeq = +(process.argv[2] || 6);
const hard = process.argv.includes('--hard');
const len = arg('--len', 30), fps = arg('--fps', 10), offset = arg('--offset', 0);
const W = 640, H = 360;
const mk = () => ({ ok: 0, wrong: 0, none: 0 });
const tot = { a: mk(), b: mk() }, flow = { a: mk(), b: mk() }, touch = { a: mk(), b: mk() };
const hows = {};
const wrongs = [];
for (let s = 1 + offset; s <= nSeq + offset; s++) {
  const sim = new TapSimulator({ seed: s, touches: 2 });
  const { opts: scene } = randomScene(20000 + s, hard);
  const t0 = Math.max(0, sim.touches[0].start - 12);
  const trackA = {}, trackB = {};
  const buf = new Uint8ClampedArray(W * H * 4);
  for (let k = 0; k < len * fps; k++) {
    const t = t0 + k / fps;
    const truth = sim.displayValue(t);
    renderDisplay(buf, W, H, {
      ...scene, text: String(truth), digitH: scene.digitH * (W / 960),
      cx: W / 2 + 12 * Math.sin(t * 0.9), cy: H / 2 + 6 * Math.sin(t * 1.4), seed: s * 10000 + k,
      glare: scene.glare.map((g) => ({ ...g, x: g.x * (W / 960), y: g.y * (H / 540) })),
      clutter: [],
    });
    const sample = makeSampler(buf, W, H);
    const view = { x: 0, y: 0, w: W, h: H };
    const a = readFrame(sample, W, H, view, {}, trackA);
    const b = readFrame(sample, W, H, view, {}, trackB, t);
    const part = sim.inTouch(t) || sim.inTouch(t - 1) ? touch : flow;
    for (const [key, r] of [['a', a], ['b', b]]) {
      const k = r.ok && r.value === truth ? 'ok' : r.ok ? 'wrong' : 'none';
      tot[key][k]++; part[key][k]++;
      if (k === 'wrong') wrongs.push(`${key === 'a' ? 'frame' : 'tracker'} seq ${s} t=${t.toFixed(1)} truth ${truth} read ${r.value} (${r.how})`);
    }
    hows[b.how] = (hows[b.how] || 0) + 1;
  }
}
const pct = (o) => { const n = o.ok + o.wrong + o.none; return `read ${(100 * o.ok / n).toFixed(1)}%  wrong ${o.wrong} (${(100 * o.wrong / n).toFixed(2)}%)  none ${(100 * o.none / n).toFixed(1)}%`; };
console.log(`${nSeq} sequences x ${len}s @${fps}fps${hard ? ' (hard)' : ''}`);
console.log(`  frame by frame : ${pct(tot.a)}`);
console.log(`  with tracker   : ${pct(tot.b)}`);
console.log(`  normal flow    : frame ${pct(flow.a)} | tracker ${pct(flow.b)}`);
console.log(`  touch periods  : frame ${pct(touch.a)} | tracker ${pct(touch.b)}`);
console.log('  tracker outcomes', JSON.stringify(hows));
for (const w of wrongs.slice(0, 20)) console.log('  WRONG', w);
