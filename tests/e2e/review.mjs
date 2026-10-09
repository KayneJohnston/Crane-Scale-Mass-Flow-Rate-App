// End-to-end test of keeping hard frames and labelling them (the Review tab), in
// headless Chromium. The camera is a canvas stream of a simulated display, part of
// which is hidden every few seconds (as by fumes), so it can't be read.
//   node tests/e2e/review.mjs [outDir]
// Checks: crops are kept and counted on the tab; one is labelled from the answers
// offered, one typed in, one marked "can't tell"; the export is a .zip of PNGs with a
// table; the reader test runs on the labelled pictures; no runtime errors.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { serve } from '../../tools/serve.mjs';
import { readZip } from '../../js/zip.js';
import { decodePNG } from '../../tools/png.js';

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
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.addInitScript(() => {
  localStorage.setItem('tapRate.settings.v1', JSON.stringify({ zoom: 1.4, resolution: '1080p' }));
  navigator.mediaDevices.getUserMedia = async () => {
    const { renderDisplay } = await import('/js/vision/render7seg.js');
    const W = 960, H = 540;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const hard = t % 8 > 4.5; // 3.5 s of every 8 hard to read
      const cx = W / 2 + 20 * Math.sin(t * 0.7);
      renderDisplay(img.data, W, H, {
        text: String(18000 + 50 * Math.floor(t / 6)), digitH: 34, cx, cy: H / 2, slantDeg: 7, noise: 3, glow: 0.35, seed: Math.floor(t * 10) + 1,
      });
      c2.putImageData(img, 0, 0);
      if (hard) { c2.fillStyle = 'rgb(26,22,24)'; c2.fillRect(cx - 14, H / 2 + 1, 26, 18); } // the lower half of the middle digit hidden
    };
    draw();
    setInterval(draw, 80);
    return cv.captureStream(15);
  };
});

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed = true; };

await page.goto(base);
await page.click('#btnCamera');
await page.waitForTimeout(26000);
await page.click('#btnPower');
await page.waitForTimeout(1000); // (a picture taken just before may still be being saved)
const kept = await page.evaluate(async () => (await window.__tapRate.crops.list()).map((c) => ({ kind: c.kind, w: c.w, h: c.h })));
const kinds = [...new Set(kept.map((c) => c.kind))];
console.log(`   kept ${kept.length} crops: ${kinds.join(', ')}`);
check(kept.length >= 3 && kinds.includes('sample') && kinds.some((k) => k !== 'sample'), 'hard frames and a clear sample kept');
const badge = await page.textContent('#reviewBadge');
check(+badge === kept.length, `the Review tab counts them (${badge})`);

await page.click('.tab[data-view="review"]');
await page.waitForFunction(() => document.getElementById('reviewImg').naturalWidth > 0, null, { timeout: 10000 });
await page.screenshot({ path: `${out}/review-1.png` });
const imgW = await page.evaluate(() => document.getElementById('reviewImg').naturalWidth);
check(imgW > 50, `the picture shows (${imgW} px wide)`);
const meta = await page.textContent('#reviewMeta');
console.log(`   first: ${meta.replace(/\s+/g, ' ').slice(0, 120)}`);
const choices = await page.$$('#reviewChoices button');
check(choices.length >= 1, `answers offered (${choices.length})`);
const first = await page.evaluate(() => document.getElementById('reviewChoices').firstElementChild?.textContent);
// (each answer saves the label, then shows the next picture)
const labelled = (n) => page.waitForFunction(async (k) => (await window.__tapRate.crops.list()).filter((c) => c.label != null).length >= k
  && document.getElementById('reviewImg').complete, n, { timeout: 10000, polling: 100 });
await choices[0].click();
await labelled(1);
await page.waitForTimeout(200);
await page.fill('#reviewValue', '18050');
await page.click('#reviewForm button[type="submit"]');
await labelled(2);
await page.waitForTimeout(200);
await page.click('#btnReviewUnreadable');
await labelled(3);
await page.waitForTimeout(300);
const labels = await page.evaluate(async () => (await window.__tapRate.crops.list()).filter((c) => c.label != null).map((c) => c.label));
console.log(`   labels: ${labels.join(', ')} (first answer offered: ${first})`);
check(labels.length === 3 && labels.includes(18050) && labels.includes('unreadable'), 'three crops labelled');
check(+(await page.textContent('#reviewBadge') || 0) === kept.length - 3, 'the count went down by three');
await page.screenshot({ path: `${out}/review-2.png`, fullPage: true });

const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#btnCropExport')]);
const zipPath = `${out}/review-export.zip`;
await dl.saveAs(zipPath);
const files = readZip(readFileSync(zipPath));
const pngs = files.filter((f) => f.name.endsWith('.png'));
const json = JSON.parse(new TextDecoder().decode(files.find((f) => f.name === 'crops.json').data));
let decoded = 0;
for (const f of pngs) { try { const p = decodePNG(Buffer.from(f.data)); if (p.width > 0) decoded++; } catch { /* counted below */ } }
check(pngs.length === kept.length && decoded === pngs.length, `export: ${pngs.length} PNG pictures, ${decoded} readable`);
check(files.some((f) => f.name === 'labels.csv') && json.crops.filter((c) => c.label != null).length === 3, 'export: table and labels');

await page.click('#btnCropTest');
await page.waitForFunction(() => /Reader test on/.test(document.getElementById('reviewStats').textContent), null, { timeout: 30000 });
console.log(`   ${(await page.textContent('#reviewStats')).split('\n').join(' | ')}`);
check(true, 'reader test ran');
check(errors.length === 0, `no runtime errors ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
