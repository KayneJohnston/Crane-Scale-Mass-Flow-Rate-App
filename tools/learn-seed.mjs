// Digit shapes learned from labelled pictures of the display, built into the app so the
// reader starts out knowing this display's digits (js/vision/seed-looks.js).
//   node tools/learn-seed.mjs <dir ...> [--fix labels.json] [--modes hot] [--out js/vision/seed-looks.js]
//
// Each <dir> is what tools/teach-import.mjs wrote (pictures.json, pictures/, clips/) or
// what tools/crops-import.mjs wrote (truth.json and fNNNN.png: pictures the person
// labelled in Review). Every labelled picture is read on its own - as the app would
// without the readings before it - and teaches what one answer would (js/vision/learn.js;
// a clip's frames, one moment, together are one answer):
// the digits the reader was not sure of, or got wrong, with what they really were. The
// looks that collect enough of the same answer go into the file.
// --fix: labels found wrong by eye, {"<picture id>" | "<review dir>/<n>" | "<clip>/<n>": value}.
// --modes: keep only the looks of these colour modes (the ones the display is read in).
// The file holds 7 numbers per look (how much of each segment was lit) - no pictures.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { decodePNG } from './png.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';
import { DigitMemory, lessonsOf } from '../js/vision/learn.js';
import { DEFAULTS } from '../js/settings.js';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : null; };
const out = opt('--out') || 'js/vision/seed-looks.js';
const fixFile = opt('--fix');
const modes = (opt('--modes') || '').split(',').filter(Boolean);
const dirs = args;
if (!dirs.length) {
  console.error('usage: node tools/learn-seed.mjs <dir ...> [--fix labels.json] [--modes hot] [--out js/vision/seed-looks.js]');
  process.exit(1);
}
const fix = fixFile ? JSON.parse(readFileSync(fixFile, 'utf8')) : {};
const cfg = { minKg: DEFAULTS.minKg, maxKg: DEFAULTS.maxKg, stepKg: DEFAULTS.stepKg, multiplier: DEFAULTS.multiplier, temporal: false };

// every labelled picture: {png, truth, group} (a clip is one group)
const items = [];
for (const dir of dirs) {
  if (existsSync(join(dir, 'pictures.json'))) {
    for (const p of JSON.parse(readFileSync(join(dir, 'pictures.json'), 'utf8'))) {
      const truth = fix[p.id] ?? p.truth;
      if (truth != null && p.png?.display) items.push({ png: join(dir, p.png.display), truth, group: p.id });
    }
    const clips = join(dir, 'clips');
    for (const c of existsSync(clips) ? readdirSync(clips) : []) {
      const tf = join(clips, c, 'truth.json');
      if (!existsSync(tf)) continue;
      const truth = JSON.parse(readFileSync(tf, 'utf8'));
      for (const f of readdirSync(join(clips, c)).filter((f) => /^f\d+\.png$/.test(f))) {
        const n = +f.slice(1, -4), v = fix[`${c}/${n}`] ?? truth[n];
        if (typeof v === 'number') items.push({ png: join(clips, c, f), truth: v, group: c });
      }
    }
  } else if (existsSync(join(dir, 'truth.json'))) {
    const truth = JSON.parse(readFileSync(join(dir, 'truth.json'), 'utf8'));
    for (const [n, val] of Object.entries(truth)) {
      const v = fix[`${basename(dir)}/${n}`] ?? val;
      if (typeof v === 'number') items.push({ png: join(dir, `f${String(n).padStart(4, '0')}.png`), truth: v, group: `${basename(dir)}/${n}` });
    }
  } else console.warn(`${dir}: no pictures.json or truth.json - left out`);
}

const read = (it, learned) => {
  const { width: w, height: h, data } = decodePNG(readFileSync(it.png));
  return readFrame(makeSampler(data, w, h), w, h, { x: 0, y: 0, w, h }, { ...cfg, expectDigits: String(Math.round(it.truth / cfg.multiplier)).length, learned });
};
const mem = new DigitMemory();
const before = { right: 0, wrong: 0 };
const groups = new Map();
for (const it of items) {
  const r = read(it);
  if (r.ok) before[r.value === it.truth ? 'right' : 'wrong']++;
  if (!groups.has(it.group)) groups.set(it.group, []);
  groups.get(it.group).push(...lessonsOf(r, it.truth, cfg));
}
for (const ls of groups.values()) mem.learn(ls);
// (marked as the app's own: they help the reader but never make a reading doubtful, sevenseg.js)
const looks = Object.fromEntries(Object.entries(mem.active()).filter(([m]) => !modes.length || modes.includes(m))
  .map(([m, xs]) => [m, xs.map((x) => ({ d: x.d, v: x.v, seed: true }))]));
const after = { right: 0, wrong: 0 };
for (const it of items) {
  const r = read(it, looks);
  if (r.ok) after[r.value === it.truth ? 'right' : 'wrong']++;
}
const n = Object.values(looks).reduce((a, x) => a + x.length, 0);
const day = new Date().toISOString().slice(0, 10);
writeFileSync(out, `// Digit shapes learned from ${items.length} labelled pictures of the display (${day},
// tools/learn-seed.mjs): how much of each segment (a-g) was lit in digits the reader was
// not sure of, per colour mode. The app starts out with these (js/vision/learn.js, the
// reader's "looks"), as if the person had already answered about them - except that they
// never make a reading doubtful (sevenseg.js). Settings can turn them off. No pictures:
// 7 numbers per look.
export const SEED_LOOKS = {
${Object.entries(looks).map(([m, xs]) => `  ${m}: [\n${xs.map((x) => `    { d: ${x.d}, v: [${x.v.join(', ')}], seed: true },\n`).join('')}  ],\n`).join('')}};
export const SEED_ABOUT = ${JSON.stringify({ made: day, pictures: items.length, moments: groups.size, looks: n })};
`);
console.log(`${items.length} labelled pictures (${groups.size} moments), ${mem.stats().answers} with something to teach: ${n} looks (${Object.entries(looks).map(([m, x]) => `${m} ${x.length}`).join(', ')}) -> ${out}`);
console.log(`read on their own: ${before.right} right, ${before.wrong} wrong before; ${after.right} right, ${after.wrong} wrong with the looks (the same pictures: no test of new ones)`);
