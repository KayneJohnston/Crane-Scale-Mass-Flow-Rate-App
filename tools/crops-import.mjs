// Pictures labelled in the app's Review tab (exported as a .zip), as test material.
//   node tools/crops-import.mjs <export.zip> <outdir>
//
// Writes each labelled picture as <outdir>/fNNNN.png with <outdir>/truth.json
// (number -> value shown: the layout tools/lattice-calib.mjs "real" reads) and
// <outdir>/crops.json (everything the app knew about each frame). Then reads every
// picture again with the reader as it is now - each on its own, without the history
// that helped in the app - and lists what it makes of them: read right, not read,
// misread. Pictures for tests/real.test.js are best copied by hand from there: they
// are public in the repository, so only crops of the display.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { readZip } from '../js/zip.js';
import { decodePNG } from './png.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';

const [zipFile, outDir] = process.argv.slice(2);
if (!zipFile || !outDir) {
  console.error('usage: node tools/crops-import.mjs <export.zip> <outdir>');
  process.exit(1);
}
// (also from an archive unpacked and packed again: in a folder, with macOS extras)
const base = (name) => name.slice(name.lastIndexOf('/') + 1);
const files = new Map(readZip(readFileSync(zipFile), inflateRawSync)
  .filter((f) => !f.name.startsWith('__MACOSX') && !base(f.name).startsWith('._'))
  .map((f) => [f.name.endsWith('.png') ? `crops/${base(f.name)}` : base(f.name), f.data]));
const meta = JSON.parse(new TextDecoder().decode(files.get('crops.json')));
const display = meta.display || {};
mkdirSync(outDir, { recursive: true });

const truth = {}, kept = [];
const tally = { right: 0, none: 0, wrong: 0, unreadable: 0, unlabelled: 0 };
const byKind = {};
let n = 0;
for (const c of meta.crops) {
  if (c.label == null) { tally.unlabelled++; continue; }
  if (c.label === 'unreadable') { tally.unreadable++; continue; }
  const png = files.get(c.file);
  if (!png) { console.warn(`missing ${c.file}`); continue; }
  const name = `f${String(++n).padStart(4, '0')}.png`;
  writeFileSync(`${outDir}/${name}`, png);
  truth[n] = c.label;
  const { width: w, height: h, data } = decodePNG(Buffer.from(png));
  const r = readFrame(makeSampler(data, w, h), w, h, { x: 0, y: 0, w, h }, { ...display });
  const now = !r.ok ? 'none' : r.value === c.label ? 'right' : 'wrong';
  tally[now]++;
  const k = (byKind[c.kind] ||= { n: 0, right: 0, none: 0, wrong: 0, appRight: 0 });
  k.n++; k[now]++;
  if (c.value === c.label) k.appRight++;
  kept.push({ name, ...c, reread: r.ok ? r.value : null, rereadReason: r.ok ? null : r.reason });
  if (now !== 'right') {
    const app = c.value != null ? `${c.how === 'prior' ? '≈' : ''}${c.value}` : `not read (${c.reason ?? c.how})`;
    console.log(`${name}  shows ${c.label}  ${now === 'wrong' ? `MISREAD as ${r.value}` : `not read (${r.reason})`}  | in the app: ${app}  [${c.kind}, ${c.file}]`);
  }
}
writeFileSync(`${outDir}/truth.json`, JSON.stringify(truth, null, 1));
writeFileSync(`${outDir}/crops.json`, JSON.stringify(kept, null, 1));
const labelled = tally.right + tally.none + tally.wrong;
console.log(`\n${labelled} labelled pictures (${tally.unreadable} "can't tell", ${tally.unlabelled} not labelled) -> ${outDir}`);
console.log(`read again on their own: ${tally.right} right, ${tally.none} not read, ${tally.wrong} misread`);
for (const [k, v] of Object.entries(byKind)) {
  console.log(`  ${k.padEnd(8)} ${String(v.n).padStart(4)}: read right ${v.right}, not read ${v.none}, misread ${v.wrong} | the app's own value was right ${v.appRight}`);
}
