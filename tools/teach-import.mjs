// Teach data sent by the app (teach mode, js/teach.js) as test material for the reader.
//   node tools/teach-import.mjs <folder or .zip ...> <outdir> [--read]
//
// Takes every teach zip in the folders given (a clone of the teach-data repository:
// teach/2026-10-10/094215_a1b2c3.zip ...). For each picture it works out what the
// display showed, where that can be known:
//   - what the person said (an answer within 1 s of it), else
//   - the clear readings around it (the app's, or the person's): the last within 5 s
//     before and the first within 5 s after show the same value - the weight only rises
//     during a tap, so it was that in between. (For a frame the app read clearly that is
//     mostly its own reading: those test that it stays right. The frames it couldn't
//     read are the ones that show what to improve.)
// Writes:
//   <outdir>/pictures/<id>_display.png, <id>_view.png and pictures.json: what is known
//     about each picture, with that value ("truth") and where it came from ("from");
//   <outdir>/clips/<clip>/f001.png ... with truth.json and times.json: a clip, read again
//     with its history by  node tools/learn-eval.mjs video <dir> <dir>/truth.json
// With --read, the reader as it is now reads every display picture on its own and every
// clip with its history, and <outdir>/report.txt says how it did by colour mode, digit
// height, light and angle, and which pictures it misread or couldn't read.
// (Review zips, review/...zip, are read by tools/crops-import.mjs.) Needs ffmpeg.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { join } from 'node:path';
import { readZip } from '../js/zip.js';
import { labelOf } from '../js/teach.js';
import { encodePNG } from './png.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';

const args = process.argv.slice(2);
const doRead = args.includes('--read');
const paths = args.filter((a) => !a.startsWith('--'));
const outDir = paths.pop();
if (!paths.length || !outDir) {
  console.error('usage: node tools/teach-import.mjs <folder or .zip ...> <outdir> [--read]');
  process.exit(1);
}

const zipsIn = (p) => (statSync(p).isDirectory() ? readdirSync(p).sort().flatMap((f) => (f.startsWith('.') ? [] : zipsIn(join(p, f)))) : p.endsWith('.zip') ? [p] : []);

// a JPEG -> RGBA pixels (w x h known from teach.json)
function jpegRGBA(bytes, w, h) {
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { input: bytes, maxBuffer: 1 << 30 });
  if (raw.length !== w * h * 4) throw new Error(`picture is not ${w}x${h}`);
  return new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
}

const zips = paths.flatMap(zipsIn);
mkdirSync(join(outDir, 'pictures'), { recursive: true });
const pictures = [], clips = new Map();
let cfg = null, nZips = 0;
for (const zf of zips) {
  const files = new Map(readZip(readFileSync(zf), inflateRawSync).map((f) => [f.name, f.data]));
  if (!files.has('teach.json')) continue; // (a Review zip: tools/crops-import.mjs)
  nZips++;
  const meta = JSON.parse(new TextDecoder().decode(files.get('teach.json')));
  cfg ||= { minKg: 1000, maxKg: 40000, stepKg: 50, multiplier: 1, ...meta.display };
  const readings = meta.readings || [], answers = meta.answers || [];
  for (const s of meta.samples) {
    const label = labelOf(s.wall, readings, answers);
    const rec = { ...s, zip: zf, device: meta.device, version: meta.version, ...label, png: {} };
    for (const [name, file] of Object.entries(s.files || {})) {
      const size = name === 'view' ? s.view : s.rect;
      if (!size || !files.has(file)) continue;
      const rgba = jpegRGBA(files.get(file), size.outW, size.outH);
      const png = s.clip ? null : `pictures/${s.id}_${name}.png`;
      if (png) writeFileSync(join(outDir, png), encodePNG(rgba, size.outW, size.outH));
      rec.png[name] = png;
      if (name === 'display') rec.pixels = rgba; // (kept for --read and the clips)
    }
    if (s.clip) {
      if (!clips.has(s.clip)) clips.set(s.clip, []);
      clips.get(s.clip).push(rec);
    } else pictures.push(rec);
  }
}
if (!nZips) { console.error('no teach zips found'); process.exit(1); }

// the clips: frames in order, with what is known of each
for (const [key, frames] of clips) {
  frames.sort((a, b) => a.i - b.i);
  const dir = join(outDir, 'clips', key.replace(/[^\w.-]/g, '_'));
  mkdirSync(dir, { recursive: true });
  const truth = {}, times = {};
  frames.forEach((f, k) => {
    const n = k + 1;
    if (f.pixels) writeFileSync(join(dir, `f${String(n).padStart(3, '0')}.png`), encodePNG(f.pixels, f.rect.outW, f.rect.outH));
    if (f.truth != null) truth[n] = f.truth;
    times[n] = +(f.t - frames[0].t).toFixed(3);
  });
  writeFileSync(join(dir, 'truth.json'), JSON.stringify(truth));
  writeFileSync(join(dir, 'times.json'), JSON.stringify(times));
}
writeFileSync(join(outDir, 'pictures.json'), JSON.stringify(pictures.map(({ pixels, ...p }) => p), null, 1));
const known = pictures.filter((p) => p.truth != null);
console.log(`${nZips} zips: ${pictures.length} pictures (${known.length} with the value known: ${known.filter((p) => p.from === 'person').length} from the person), ${clips.size} clips (${[...clips.values()].reduce((a, f) => a + f.length, 0)} frames) -> ${outDir}`);

if (doRead) {
  const lines = [];
  const say = (s = '') => { lines.push(s); console.log(s); };
  const C = { ...cfg };
  // every display picture on its own, by condition
  const by = {}, fails = [];
  const bin = (name, v) => ((by[name] ||= {})[v] ||= { n: 0, right: 0, none: 0, wrong: 0 });
  const conds = (p) => ({
    kind: p.kind,
    'colour mode (app)': p.reading?.mode || 'none',
    'digit height px': p.reading?.digitHpx == null ? 'unknown' : p.reading.digitHpx < 30 ? '<30' : p.reading.digitHpx < 60 ? '30-60' : p.reading.digitHpx < 120 ? '60-120' : '120+',
    'light (display, mean)': p.light?.display == null ? 'unknown' : p.light.display.mean < 50 ? 'dark <50' : p.light.display.mean < 110 ? '50-110' : 'bright 110+',
    'angle (deg)': p.reading?.rotDeg == null ? 'unknown' : Math.abs(p.reading.rotDeg) < 3 ? '<3' : Math.abs(p.reading.rotDeg) < 8 ? '3-8' : '8+',
    'hour': new Date(p.wall).getHours(),
  });
  for (const p of known) {
    if (!p.pixels) continue;
    const r = readFrame(makeSampler(p.pixels, p.rect.outW, p.rect.outH), p.rect.outW, p.rect.outH, { x: 0, y: 0, w: p.rect.outW, h: p.rect.outH }, C);
    const out = !r.ok ? 'none' : r.value === p.truth ? 'right' : 'wrong';
    for (const [k, v] of Object.entries(conds(p))) { const b = bin(k, v); b.n++; b[out]++; }
    if (out !== 'right') fails.push(`${p.png.display}: ${p.truth} (${p.from}) read ${r.ok ? r.value : `nothing (${r.reason})`}; the app: ${p.reading?.ok ? p.reading.value : `nothing (${p.reading?.reason})`}`);
  }
  say(`The reader now, each display picture on its own (${known.length} with the value known):`);
  for (const [k, bins] of Object.entries(by)) {
    say(`  ${k}:`);
    for (const [v, b] of Object.entries(bins).sort()) say(`    ${String(v).padEnd(12)} ${String(b.n).padStart(4)}: ${String(b.right).padStart(4)} right, ${String(b.none).padStart(3)} not read, ${String(b.wrong).padStart(3)} wrong`);
  }
  // every clip with its history
  say('');
  say('Clips, read with the history (frames with the value known):');
  for (const [key, frames] of clips) {
    const track = {}, T = { n: 0, right: 0, none: 0, wrong: 0 };
    for (const f of frames) {
      if (!f.pixels) continue;
      const r = readFrame(makeSampler(f.pixels, f.rect.outW, f.rect.outH), f.rect.outW, f.rect.outH, { x: 0, y: 0, w: f.rect.outW, h: f.rect.outH }, C, track, f.t);
      if (f.truth == null) continue;
      T.n++;
      T[!r.ok ? 'none' : r.value === f.truth ? 'right' : 'wrong']++;
    }
    say(`  ${key} (${frames[0].why}, ${frames.length} frames): ${T.right} of ${T.n} right, ${T.none} not read, ${T.wrong} wrong`);
  }
  if (fails.length) { say(''); say(`Not read right on their own (${fails.length}):`); for (const f of fails) say(`  ${f}`); }
  writeFileSync(join(outDir, 'report.txt'), lines.join('\n') + '\n');
}
