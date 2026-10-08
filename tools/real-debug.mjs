// Run the reader on a real photo and dump what it sees (needs ffmpeg for JPEG/PNG).
//   node tools/real-debug.mjs <photo.jpg | file.rgba width height> [outDir] [x y w h]
// CFG='{"colorMode":"hot"}' overrides reader settings.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { locateDisplay } from '../js/vision/sevenseg.js';
import { encodePNG } from './png.js';

const args = process.argv.slice(2);
const file = args.shift();
let w, h, buf;
if (file.endsWith('.rgba')) {
  w = +args.shift(); h = +args.shift();
  buf = new Uint8ClampedArray(readFileSync(file).buffer);
} else {
  // ffmpeg applies the photo's EXIF rotation, so the image is upright as on the phone
  [w, h] = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim().split(',').map(Number);
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { maxBuffer: 1 << 30 });
  if (raw.length !== w * h * 4) [w, h] = [h, w]; // rotated by EXIF orientation
  buf = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
}
const [out, ...rect] = args;
const view = rect.length === 4 ? { x: +rect[0], y: +rect[1], w: +rect[2], h: +rect[3] } : { x: 0, y: 0, w, h };
const cfg = JSON.parse(process.env.CFG || '{}');
const sample = makeSampler(buf, w, h);
const res = readFrame(sample, w, h, view, { keepDebug: true, ...cfg });
console.log(JSON.stringify({ ok: res.ok, value: res.value, reason: res.reason, text: res.text, how: res.how, mode: res.mode, located: res.located && Object.fromEntries(Object.entries(res.located).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v) : v])), digitHpx: res.digitHpx && +res.digitHpx.toFixed(1) }));
const s = res.debug?.search;
if (s) {
  const loc = locateDisplay(s.img, s.w, s.h, { colorMode: res.mode || 'red' });
  console.log('search', s.w, 'x', s.h, 'T', loc.threshold, 'contrast', loc.contrast, 'candidates', JSON.stringify(loc.candidates.map((c) => ({ x: c.x, y: c.y, w: c.w, h: c.h, mass: c.mass, score: Math.round(c.score) }))));
}
const rd = res.debug?.read?.res;
if (rd) {
  console.log('read crop', res.debug.read.w, 'x', res.debug.read.h, 'T', rd.threshold, 'contrast', rd.contrast, 'rot', rd.rotDeg?.toFixed(1), 'shear', rd.shear?.toFixed(2), 'H', rd.digitH?.toFixed(1), 'reason', rd.reason, 'pitch', rd.pitch?.toFixed(2));
  for (const d of rd.digits) console.log('  ', d.ch, 'cost', d.cost?.toFixed(2), 'margin', d.margin?.toFixed(2), d.fills ? 'fills ' + d.fills.join(' ') : `cover ${d.cover} wid ${d.wid} ext ${d.extent}`);
  console.log('  extras', JSON.stringify(rd.extras.map((e) => ({ u0: Math.round(e.u0), u1: Math.round(e.u1), v0: Math.round(e.v0), v1: Math.round(e.v1), mass: Math.round(e.mass) }))));
  if (rd.seg) console.log('  seg', JSON.stringify(rd.seg));
}
if (out) {
  mkdirSync(out, { recursive: true });
  const base = file.split('/').pop().replace(/\.[^.]+$/, '');
  if (s) writeFileSync(`${out}/${base}-search.png`, encodePNG(s.img, s.w, s.h));
  if (res.debug?.read) {
    const { img, w: rw, h: rh, res: r } = res.debug.read;
    writeFileSync(`${out}/${base}-crop.png`, encodePNG(img, rw, rh));
    if (r.mask) {
      const m = new Uint8ClampedArray(rw * rh * 4);
      for (let i = 0; i < rw * rh; i++) { const v = r.mask.data[i] > r.mask.T ? 255 : r.mask.data[i] / 3; m[i * 4] = m[i * 4 + 1] = m[i * 4 + 2] = v; m[i * 4 + 3] = 255; }
      writeFileSync(`${out}/${base}-mask.png`, encodePNG(m, rw, rh));
    }
  }
}
