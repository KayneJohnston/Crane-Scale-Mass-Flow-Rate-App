// Monte-Carlo evaluation of the seven-segment reader on synthetic scenes.
//   node tools/vision-eval.mjs [count] [--dump dir]
// Reports read rate, wrong-read rate (the dangerous one) and failure reasons.
import { renderDisplay, mulberry32 } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { encodePNG } from './png.js';
import { writeFileSync, mkdirSync } from 'node:fs';

const count = +(process.argv[2] || 200);
const offIdx = process.argv.indexOf('--offset');
const offset = offIdx > 0 ? +process.argv[offIdx + 1] : 0;
const dumpIdx = process.argv.indexOf('--dump');
const dumpDir = dumpIdx > 0 ? process.argv[dumpIdx + 1] : null;
if (dumpDir) mkdirSync(dumpDir, { recursive: true });

/**
 * Over-exposed display like the real crane scale photographed from the floor:
 * thin cream segment cores, a saturated red bloom filling the digit area, a dark
 * red window in a light bezel, lit indicator LEDs left of the digits (inside the
 * window, about one digit height left of the first cell) and a lit dot after the
 * last digit. Values below 10000 leave the first of the five cells blank.
 */
export function hotScene(seed, opts = {}) {
  const rnd = mulberry32(seed * 977 + 13);
  const U = (a, b) => a + (b - a) * rnd();
  const W = opts.W || 960, H = opts.H || 540;
  const value = opts.value ?? (rnd() < 0.3 ? 1000 + 50 * Math.floor(rnd() * 180) : 13000 + 50 * Math.floor(rnd() * 261));
  const text = String(value).padStart(5, ' ');
  const digitH = opts.digitH ?? U(22, 60);
  const cx = U(0.35, 0.65) * W, cy = U(0.35, 0.65) * H;
  const pitch = U(0.74, 0.86);
  // indicator LEDs: a stacked pair or a single one, left of the first cell
  const ledU = -U(0.75, 1.2), ledR = U(0.07, 0.12);
  const leds = rnd() < 0.5 ? [{ u: ledU, v: U(0.15, 0.3), r: ledR }, { u: ledU, v: U(0.7, 0.85), r: ledR }] : [{ u: ledU, v: U(0.2, 0.8), r: ledR }];
  const opts2 = {
    text, digitH, cx, cy,
    slantDeg: U(6, 12), rotDeg: U(-5, 5), widthRatio: U(0.52, 0.6), thickRatio: U(0.05, 0.12), gapRatio: U(0.02, 0.04), pitchRatio: pitch,
    lit: [255, Math.round(U(205, 240)), Math.round(U(150, 200))],
    glowColor: [255, Math.round(U(10, 40)), Math.round(U(10, 35))], glow: U(1.6, 3), glowRadius: U(0.08, 0.14),
    panel: true, panelColor: [Math.round(U(50, 90)), 12, 14], panelPad: U(0.25, 0.4), panelPadL: -ledU + U(0.35, 0.6),
    bezel: { color: [Math.round(U(170, 215)), Math.round(U(165, 205)), Math.round(U(160, 200))], width: U(0.25, 0.45) },
    bg: [Math.round(U(120, 190)), Math.round(U(110, 170)), Math.round(U(50, 100))],
    noise: U(2, 7), blur: rnd() < 0.5 ? 0 : U(1, 1.8), seed: seed * 3 + 1,
    leds,
    // the window's lip reflecting the glow: a thin bright line touching the bottom of
    // the digits (and sometimes one clear of their top, like the real display's frame)
    hlines: [
      ...(rnd() < 0.5 ? [{ v: U(0.99, 1.05), t: U(0.025, 0.06) }] : []),
      ...(rnd() < 0.25 ? [{ v: -U(0.15, 0.25), t: U(0.025, 0.05) }] : []),
    ],
    dp: text.length - 1,
    glare: rnd() < 0.4 ? [{ x: U(0, W), y: U(0, H * 0.3), r: U(40, 160), i: U(80, 200) }] : [],
  };
  // dashes at the middle height, as on the real display at 21,800 ("-2-1800."): one in
  // front of the first digit and one in the left of each "1" cell after the first
  if (opts.dashes) {
    const first = text.search(/\S/), cw = opts2.widthRatio;
    opts2.dashes = [{ u0: first * pitch - U(0.45, 0.6), u1: first * pitch - U(0.1, 0.18) }];
    for (let i = first + 1; i < text.length; i++) {
      if (text[i] === '1') opts2.dashes.push({ u0: i * pitch - U(0.12, 0.2), u1: i * pitch + cw * U(0.35, 0.5) });
    }
  }
  return { W, H, value, opts: opts2 };
}

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
  const hot = process.argv.includes('--hot');
  for (let s = 1 + offset; s <= count + offset; s++) {
    const { W, H, value, opts } = hot ? hotScene(s, { dashes: process.argv.includes('--dashes') }) : randomScene(s, process.argv.includes('--hard'));
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
      if (process.argv.includes('-v')) console.log(`fail seed=${s} ${res.reason} text=${res.text} H=${opts.digitH.toFixed(1)} slant=${opts.slantDeg.toFixed(1)} rot=${opts.rotDeg.toFixed(1)} ghost=${(opts.ghost ?? 0).toFixed(2)} hot=${(opts.hot ?? 0).toFixed(2)} glare=${opts.glare.length}`);
    }
  }
  const ms = (Date.now() - t0) / count;
  console.log(`n=${count} ok=${ok} (${((100 * ok) / count).toFixed(1)}%) wrong=${wrong} failed=${failed} ~${ms.toFixed(0)} ms/frame incl. render`);
  console.log('fail reasons', reasons);
}

if (import.meta.url === `file://${process.argv[1]}`) run();
