// End-to-end test of "Analyse a video" in headless Chromium.
//   node tests/e2e/video.mjs [outDir]      (renders a synthetic tap video with ffmpeg first)
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { serve } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }

const out = process.argv[2] || 'test-output';
mkdirSync(out, { recursive: true });
const vfile = `${out}/tap.webm`;
const info = JSON.parse(execFileSync('node', ['tools/make-test-video.mjs', vfile, '8', '3']).toString().trim().split('\n').pop());
console.log(`video: ${info.frames} frames, tap ${info.tapStart.toFixed(1)}-${info.tapEnd.toFixed(1)} s, avg ${info.avg.toFixed(0)} kg/min`);

const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed = true; };

await page.goto(base);
await page.click('.tab[data-view="settings"]');
await page.setInputFiles('#fileVideo', vfile);
await page.waitForFunction(() => window.__tapRate.app.vid && document.getElementById('btnStartStop').textContent.includes('Analyse'), null, { timeout: 15000 });
await page.screenshot({ path: `${out}/video-loaded.png` });
const t0 = Date.now();
await page.click('#btnStartStop');
await page.waitForFunction(() => window.__tapRate.app.vid?.running === true, null, { timeout: 5000 });
await page.waitForFunction(() => window.__tapRate.app.vid?.running === false, null, { timeout: 600000, polling: 1000 });
console.log(`   analysed in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
await page.waitForTimeout(1000);
await page.screenshot({ path: `${out}/video-done.png` });
const sessions = await page.evaluate(async () => (await window.__tapRate.store.all()).map((s) => ({ a: s.analysis, src: s.source })));
check(sessions.length === 1 && sessions[0].src === 'video', `one video session saved (${sessions.length})`);
if (sessions.length) {
  const seg = sessions[0].a.segments[0];
  console.log(`   analysis: mass ${seg?.massKg} kg (true 1200), avg ${seg?.avgKgMin} kg/min (true ${info.avg.toFixed(0)})`);
  check(seg && Math.abs(seg.massKg - 1200) < 100, 'tapped mass within 100 kg');
  check(seg && Math.abs(seg.avgKgMin - info.avg) / info.avg < 0.1, 'average rate within 10%');
}
check(errors.length === 0, `no runtime errors ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
