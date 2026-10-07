// Monte-Carlo evaluation of the seven-segment reader on synthetic scenes.
//   node tools/vision-eval.mjs [count] [--dump dir]
// Reports read rate, wrong-read rate (the dangerous one) and failure reasons.
import { renderDisplay, mulberry32 } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { encodePNG } from './png.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const count = +(process.argv[2] || 200);
const dumpIdx = process.argv.indexOf('--dump');
const dumpDir = dumpIdx > 0 ? process.argv[dumpIdx + 1] : null;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });

export function randomScene(seed, hard = false) {
  const rnd = mulberry32(seed);
  const U = (a, b) => a + (b - a) * rnd();
  const W = 960, H = 540;
  const value = 13000 + 50 * Math.floor(rnd() * 261);
  const digitH = hard ? U(12, 70) : U(18, 70);
  const opts = {
    text: String(value), digitH,
    cx: U(0.3, 0.7) * W, cy: U(0.3, 0.7) * H,
    slantDeg: U(-2, 12), rotDeg: U(-6, 6),
    widthRatio: U(0.5, 0.62), thickRatio: U(0.1, 0.18), gapRatio: U(0, 0.04), pitchRatio: U(0.72, 0.9),
    noise: U(2, hard ? 14 : 8), glow: U(0, 0.6), blur: rnd() < 0.5 ? 0 : U(1, 2),
    ghost: rnd() < 0.3 ? U(0.2, hard ? 0.7 : 0.5) : 0,
    hot: rnd() < 0.3 ? U(0.3, hard ? 1 : 0.7) : 0,
    gain: U(0.6, 1.3),
    lit: [255, Math.round(U(20, 70)), Math.round(U(10, 50))],
    seed: seed * 7 + 1,
    glare: rnd() < 0.4 ? [{ x: U(0, W), y: U(0, H), r: U(20, 120), i: U(40, hard ? 220 : 140) }] : [],
    clutter: rnd() < 0.3 ? [{ x: U(0, W), y: U(0, H), r: U(5, 30), color: [200, 40, 30] }] : [],
  };
  return { W, H, value, opts };
}

function run() {
  let ok = 0, wrong = 0, failed = 0;
  const reasons = {};
  const t0 = Date.now();
  for (let s = 1; s <= count; s++) {
    const { W, H, value, opts } = randomScene(s, process.argv.includes('--hard'));
    const buf = new Uint8ClampedArray(W * H * 4);
    renderDisplay(buf, W, H, opts);
    const sample = makeSampler(buf, W, H);
    const res = readFrame(sample, W, H, { x: 0, y: 0, w: W, h: H }, {});
    if (res.ok && res.value === value) ok++;
    else if (res.ok) {
      wrong++;
      console.log(`WRONG seed=${s} truth=${value} read=${res.value} H=${opts.digitH.toFixed(1)} slant=${opts.slantDeg.toFixed(1)} rot=${opts.rotDeg.toFixed(1)}`);
      if (dumpDir) writeFileSync(`${dumpDir}/wrong-${s}.png`, encodePNG(buf, W, H));
    } else {
      failed++;
      reasons[res.reason] = (reasons[res.reason] || 0) + 1;
      if (dumpDir && failed <= 30) writeFileSync(`${dumpDir}/fail-${s}-${res.reason}.png`, encodePNG(buf, W, H));
      if (process.argv.includes('-v')) console.log(`fail seed=${s} ${res.reason} text=${res.text} H=${opts.digitH.toFixed(1)} slant=${opts.slantDeg.toFixed(1)} rot=${opts.rotDeg.toFixed(1)} ghost=${opts.ghost.toFixed(2)} hot=${opts.hot.toFixed(2)} glare=${opts.glare.length}`);
    }
  }
  const ms = (Date.now() - t0) / count;
  console.log(`n=${count} ok=${ok} (${((100 * ok) / count).toFixed(1)}%) wrong=${wrong} failed=${failed} ~${ms.toFixed(0)} ms/frame incl. render`);
  console.log('fail reasons', reasons);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
