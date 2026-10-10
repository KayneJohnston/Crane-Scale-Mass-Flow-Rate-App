// End-to-end test of teach mode (js/teach.js) in headless Chromium, with a fake GitHub.
// The camera is a canvas stream of a simulated display, part of which is hidden for
// 3.5 s of every 8 (as by fumes), so some frames can't be read.
//   node tests/e2e/teach.mjs [outDir]
// Checks: the repository is set up and checked from Settings (a public one is refused);
// with teach mode on, "● Teach" shows on the camera picture and pictures, hard frames
// and clips are kept with what the app read; with the camera stopped they are sent to
// the repository as a zip in one commit (pictures + teach.json) and deleted from the
// phone; Review shows what was sent; the token is in no settings or backup; no runtime
// errors.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { serve } from '../../tools/serve.mjs';
import { readZip } from '../../js/zip.js';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }

const out = process.argv[2] || 'test-output';
mkdirSync(out, { recursive: true });
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, acceptDownloads: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/api\.github\.com/.test(m.text())) errors.push('console: ' + m.text()); });
page.on('dialog', (d) => d.accept());

const TOKEN = 'github_pat_test_123';
await ctx.addInitScript(() => {
  localStorage.setItem('tapRate.settings.v1', JSON.stringify({ zoom: 1.4, resolution: '1080p', askMode: 'never', teachMode: true }));
  navigator.mediaDevices.getUserMedia = async () => {
    const { renderDisplay } = await import('/js/vision/render7seg.js');
    const W = 960, H = 540;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const cx = W / 2 + 20 * Math.sin(t * 0.7);
      renderDisplay(img.data, W, H, { text: String(18000 + 50 * Math.floor(t / 6)), digitH: 34, cx, cy: H / 2, slantDeg: 7, noise: 3, glow: 0.35, seed: Math.floor(t * 10) + 1 });
      c2.putImageData(img, 0, 0);
      if (t % 8 > 4.5) { c2.fillStyle = 'rgb(26,22,24)'; c2.fillRect(cx - 14, H / 2 + 1, 26, 18); }
    };
    draw();
    setInterval(draw, 80);
    return cv.captureStream(15);
  };
});

// a fake GitHub: one repository (private unless set otherwise), its branch and objects
const gh = { isPrivate: true, calls: [], blobs: new Map(), trees: new Map(), commits: new Map([['c0', { tree: 't0', parents: [] }]]), head: 'c0', n: 0, files: [] };
gh.trees.set('t0', { entries: [] });
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, OPTIONS' };
await page.route('https://api.github.com/**', async (route) => {
  const req = route.request();
  const method = req.method();
  if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
  const path = new URL(req.url()).pathname.replace('/repos/kayne/teach-data', '');
  const body = req.postData() ? JSON.parse(req.postData()) : null;
  gh.calls.push(`${method} ${path}`);
  const json = (status, b) => route.fulfill({ status, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  if (req.headers().authorization !== `Bearer ${TOKEN}`) return json(401, { message: 'Bad credentials' });
  if (method === 'GET' && path === '') return json(200, { full_name: 'kayne/teach-data', private: gh.isPrivate, default_branch: 'main', permissions: { push: true } });
  if (method === 'GET' && path === '/git/ref/heads/main') return json(200, { object: { sha: gh.head } });
  if (method === 'POST' && path === '/git/blobs') { const b = `b${++gh.n}`; gh.blobs.set(b, body.content); return json(201, { sha: b }); }
  const mc = path.match(/^\/git\/commits\/(\w+)$/);
  if (method === 'GET' && mc) return json(200, { sha: mc[1], tree: { sha: gh.commits.get(mc[1]).tree } });
  if (method === 'POST' && path === '/git/trees') { const t = `t${++gh.n}`; gh.trees.set(t, { base: body.base_tree, entries: body.tree }); return json(201, { sha: t }); }
  if (method === 'POST' && path === '/git/commits') { const c = `c${++gh.n}`; gh.commits.set(c, { tree: body.tree, parents: body.parents, message: body.message }); return json(201, { sha: c }); }
  if (method === 'PATCH' && path === '/git/refs/heads/main') {
    if (gh.commits.get(body.sha).parents[0] !== gh.head) return json(422, { message: 'Update is not a fast forward' });
    gh.head = body.sha;
    const c = gh.commits.get(body.sha);
    for (const e of gh.trees.get(c.tree).entries) gh.files.push({ path: e.path, message: c.message, bytes: Buffer.from(gh.blobs.get(e.sha), 'base64') });
    return json(200, { object: { sha: body.sha } });
  }
  return json(404, { message: 'Not Found' });
});

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed = true; };
const kept = () => page.evaluate(async () => (await window.__tapRate.teachStore.list()));
// wait until fn (run in the page, may be async) is true
async function until(fn, ms = 10000, arg = null) {
  for (const end = Date.now() + ms; Date.now() < end; await page.waitForTimeout(300)) if (await page.evaluate(fn, arg)) return true;
  throw new Error(`timed out: ${fn}`);
}

await page.goto(base);
await page.waitForFunction(() => window.__tapRate);
check(await page.isHidden('#teachDot'), 'no “Teach” mark while the camera is off');

// set up the repository
await page.click('.tab[data-view="settings"]');
await page.fill('#ghRepo', 'https://github.com/kayne/teach-data');
await page.fill('#ghToken', TOKEN);
await page.click('#btnGhSave');
await until(() => /✓|✗/.test(document.getElementById('ghStatus').textContent), 5000);
const st = await page.textContent('#ghStatus');
console.log(`   ${st}`);
check(/✓ kayne\/teach-data is private/.test(st), 'the repository is checked');
check(await page.inputValue('#ghToken') === '' && /saved/.test(await page.getAttribute('#ghToken', 'placeholder')), 'the token is not shown again');

// filming with teach mode on
await page.click('.tab[data-view="live"]');
await page.click('#btnCamera');
await page.waitForSelector('#teachDot:not([hidden])', { timeout: 5000 });
await page.waitForTimeout(25000);
const dot = await page.textContent('#teachDot');
console.log(`   on the camera picture: “${dot.trim()}”`);
check(/Teach \d+|Clip/.test(dot), '“● Teach” shows while filming');
await page.screenshot({ path: `${out}/teach-1.png` });
await page.click('#btnPower');
await page.waitForTimeout(500);
const recs = await kept();
const samples = recs.filter((r) => r.type === 'sample');
const stills = samples.filter((s) => s.kind === 'still'), hard = samples.filter((s) => s.kind === 'hard');
const clips = [...new Set(samples.filter((s) => s.clip).map((s) => s.clip))];
const clipFrames = (k) => samples.filter((s) => s.clip === k).sort((a, b) => a.i - b.i);
console.log(`   kept: ${stills.length} pictures, ${hard.length} hard frames, ${clips.length} clips (${clips.map((k) => clipFrames(k).length).join(', ')} frames), ${recs.filter((r) => r.type === 'log').length} logs of readings, ${(samples.reduce((a, s) => a + s.bytes, 0) / 1e6).toFixed(2)} MB`);
check(stills.length >= 2 && hard.length >= 2, 'pictures every 20 s and of hard frames');
check(stills.every((s) => s.files.includes('view') && s.view.outW > 100) && hard.every((s) => s.files.includes('display')), 'each with the camera box and the display');
// (headless Chromium reads 2-4 frames a second here, the phone about 10; a frame read while
// six pictures are still being encoded is left out, so the numbers may skip one)
check(clips.length >= 2 && clips.every((k) => clipFrames(k).length >= 8 && clipFrames(k).every((f, j, a) => (j === 0 || f.i > a[j - 1].i) && JSON.stringify(f.rect) === JSON.stringify(a[0].rect))), 'clips: the frames in order, one place in the frame');
check(samples.every((s) => s.reading && 'how' in s.reading) && samples.some((s) => s.reading.ok) && samples.some((s) => !s.reading.ok), 'with what the app read');
check(recs.some((r) => r.type === 'log' && r.rows.length > 100), 'the readings of every frame are kept');

// sent while the camera is off (automatically, a few seconds after it stops)
await until(async () => !(await window.__tapRate.teachStore.list()).some((r) => r.type === 'sample'), 30000);
console.log(`   GitHub calls: ${gh.calls.length} (${[...new Set(gh.calls)].join(', ')}) | ${await page.evaluate(() => window.__tapRate.teach.status)}`);
const zips = gh.files.filter((f) => f.path.startsWith('teach/'));
console.log(`   sent: ${gh.files.map((f) => `${f.path} (${(f.bytes.length / 1e6).toFixed(2)} MB, “${f.message}”)`).join('; ')}`);
check(zips.length >= 1 && zips.every((z) => /^teach\/\d{4}-\d\d-\d\d\/\d{6}_[0-9a-f]+\.zip$/.test(z.path)), 'sent as zips, one commit each');
const files = zips.flatMap((z) => readZip(z.bytes));
const teachJson = files.filter((f) => f.name === 'teach.json').map((f) => JSON.parse(new TextDecoder().decode(f.data)));
const jpegs = files.filter((f) => f.name.endsWith('.jpg'));
const isJpeg = (d) => d[0] === 0xff && d[1] === 0xd8 && d[d.length - 2] === 0xff && d[d.length - 1] === 0xd9;
const nSent = teachJson.reduce((a, j) => a + j.samples.length, 0);
check(nSent === samples.length && jpegs.length === samples.reduce((a, s) => a + s.files.length, 0) && jpegs.every((f) => isJpeg(f.data)), `every picture sent (${nSent}), as JPEG`);
check(teachJson.every((j) => j.kind === 'teach' && j.readings.length > 50 && j.display?.stepKg === 50 && j.samples.every((s) => Object.values(s.files).every((p) => files.some((f) => f.name === p)))), 'teach.json: what the app read, the readings, the display');
writeFileSync(`${out}/teach-sent.zip`, zips[0].bytes);
check((await kept()).filter((r) => r.type === 'sample').length === 0, 'deleted from the phone once sent');

// Review says so
await page.click('.tab[data-view="review"]');
await until(() => /Sent/.test(document.getElementById('teachStats').textContent), 5000);
const stats = await page.textContent('#teachStats');
console.log(`   ${stats.split('\n').join(' | ')}`);
check(/Sent .* to kayne\/teach-data/.test(stats), 'Review says what was sent where');
await page.screenshot({ path: `${out}/teach-2.png`, fullPage: true });

// a public repository is refused
gh.isPrivate = false;
const before = gh.calls.length;
await page.click('.tab[data-view="settings"]');
await page.click('#btnGhSave');
await until(() => /✗/.test(document.getElementById('ghStatus').textContent), 5000);
check(/public: anyone could see/.test(await page.textContent('#ghStatus')) && !gh.calls.slice(before).some((c) => !c.startsWith('GET')), 'a public repository is refused');

// the token is in no settings or backup
const settingsJson = await page.evaluate(() => localStorage.getItem('tapRate.settings.v1'));
check(!settingsJson.includes(TOKEN), 'the token is not in the settings');
await page.click('.tab[data-view="history"]');
const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnBackup')]);
await dl.saveAs(`${out}/teach-backup.json`);
check(!readFileSync(`${out}/teach-backup.json`, 'utf8').includes(TOKEN), 'nor in a backup');
check(errors.length === 0, `no runtime errors ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
