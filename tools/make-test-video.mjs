// Render a synthetic crane-scale video of a simulated tap (needs ffmpeg).
//   node tools/make-test-video.mjs out.webm [fps] [seed]
// The display wobbles like a hand-held phone; noise, glow and glare included.
import { spawn } from 'node:child_process';
import { renderDisplay } from '../js/vision/render7seg.js';
import { TapSimulator } from '../js/analysis/sim.js';

const outFile = process.argv[2] || 'test-output/tap.webm';
const fps = +(process.argv[3] || 8);
const seed = +(process.argv[4] || 3);
const W = 640, H = 360;
const sim = new TapSimulator({ seed, idleBefore: 10, tapMass: 1200, rate0: 1250, rateEnd: 1000, idleAfter: 40, touches: 1, touchDur: [3, 5] });
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${W}x${H}`, '-r', String(fps), '-i', '-',
  '-c:v', 'libvpx-vp9', '-b:v', '1500k', '-g', String(fps), '-deadline', 'realtime', '-cpu-used', '8', '-pix_fmt', 'yuv420p', outFile], { stdio: ['pipe', 'inherit', 'inherit'] });
const buf = new Uint8ClampedArray(W * H * 4);
const n = Math.ceil(sim.duration * fps);
for (let i = 0; i < n; i++) {
  const t = i / fps;
  renderDisplay(buf, W, H, {
    text: String(sim.displayValue(t)), digitH: 34, cx: W / 2 + 18 * Math.sin(t * 0.7), cy: H / 2 + 8 * Math.sin(t * 1.1),
    slantDeg: 8, rotDeg: 2, noise: 4, glow: 0.4, blur: 1, seed: i + 1,
    glare: [{ x: W * 0.6, y: H * 0.35, r: 30, i: 80 }],
  });
  if (!ff.stdin.write(Buffer.from(buf.buffer))) await new Promise((r) => ff.stdin.once('drain', r));
}
ff.stdin.end();
await new Promise((r) => ff.on('close', r));
console.log(JSON.stringify({ file: outFile, frames: n, duration: sim.duration, tapStart: sim.tapStart, tapEnd: sim.tapEnd, mass: 1200, avg: sim.trueAvgRate }));
