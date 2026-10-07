// Regenerate the README screenshots from a deterministic demo run (headless Chromium).
//   node tools/screenshots.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { serve } from './serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }
mkdirSync('docs', { recursive: true });
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(base + '?demo=20&seed=' + (process.argv[2] || 11));
let shot = false;
for (let i = 0; i < 200; i++) {
  await page.waitForTimeout(250);
  const st = await page.evaluate(() => {
    const s = window.__tapRate.app.engine?.snapshot(window.__tapRate.app.demo?.t ?? 0)?.session;
    return { src: window.__tapRate.app.source, seg: s?.segElapsed ?? 0, state: document.getElementById('mainInd').dataset.state, certain: document.getElementById('mainInd').dataset.certain };
  });
  if (!shot && st.seg > 120 && ['fast', 'slow', 'ok'].includes(st.state)) {
    await page.evaluate(() => { document.getElementById('toast').hidden = true; });
    await page.screenshot({ path: 'docs/screenshot-live.png' });
    shot = true;
  }
  if (shot && st.src === null) break;
}
await page.click('.tab[data-view="history"]');
await page.waitForTimeout(400);
await page.click('.hcard');
await page.waitForTimeout(800);
await page.evaluate(() => { document.getElementById('toast').hidden = true; const d = document.getElementById('dlgSession'); d.scrollTop = 200; });
await page.waitForTimeout(300);
await page.screenshot({ path: 'docs/screenshot-history.png' });
await browser.close();
server.close();
console.log('screenshots written', shot);
