// Debug one synthetic scene: node tools/vision-debug.mjs <seed> [--hard] [--out dir]
import { renderDisplay } from '../js/vision/render7seg.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { encodePNG } from './png.js';
import { randomScene } from './vision-eval.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';

const seed = +process.argv[2];
const outIdx = process.argv.indexOf('--out');
const out = outIdx > 0 ? process.argv[outIdx + 1] : null;
const { W, H, value, opts } = randomScene(seed, process.argv.includes('--hard'));
const buf = new Uint8ClampedArray(W * H * 4);
renderDisplay(buf, W, H, opts);
const res = readFrame(makeSampler(buf, W, H), W, H, { x: 0, y: 0, w: W, h: H }, { keepDebug: true });
console.log('truth', value, 'opts', JSON.stringify({ ...opts, text: undefined, glare: opts.glare, clutter: opts.clutter }));
console.log('ok', res.ok, 'value', res.value, 'reason', res.reason, 'text', res.text, 'located', res.located);
const rd = res.debug?.read?.res;
if (rd) {
  console.log('crop', res.debug.read.w, 'x', res.debug.read.h, 'T', rd.threshold, 'contrast', rd.contrast, 'rot', rd.rotDeg.toFixed(2), 'shear', rd.shear.toFixed(3), 'H', rd.digitH.toFixed(1), 'bandFrac', rd.bandFrac?.toFixed(2));
  for (const d of rd.digits) console.log(' ', d.ch, 'cost', d.cost?.toFixed(2), 'margin', d.margin?.toFixed(2), 'fills', d.fills?.join(' '), d.cover ? 'cover ' + d.cover + ' wid ' + d.wid + ' extent ' + d.extent : '');
  console.log('extras', rd.extras.length);
}
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(`${out}/scene-${seed}.png`, encodePNG(buf, W, H));
  if (res.debug?.read) {
    const { img, w, h, res: r } = res.debug.read;
    writeFileSync(`${out}/crop-${seed}.png`, encodePNG(img, w, h));
    if (r.mask) {
      const m = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) { const v = r.mask.data[i] > r.mask.T ? 255 : r.mask.data[i] / 3; m[i * 4] = m[i * 4 + 1] = m[i * 4 + 2] = v; m[i * 4 + 3] = 255; }
      writeFileSync(`${out}/mask-${seed}.png`, encodePNG(m, w, h));
    }
  }
}
