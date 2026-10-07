// End-to-end smoke test in headless Chromium (Playwright), iPhone-sized viewport.
//   node tests/e2e/smoke.mjs [outDir]
// 1. page loads without errors
// 2. demo at 20x runs a full simulated tap and saves it to History
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { serve } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }

const out = process.argv[2] || 'test-output';
mkdirSync(out, { recursive: true });
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
await page.waitForTimeout(800);
await page.screenshot({ path: `${out}/01-start.png` });
check(errors.length === 0, `loads without errors ${errors.join(' | ')}`);

// demo at 20x
await page.goto(base + '?demo=20');
let sawTapping = false, sawRate = false;
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => ({ pill: document.getElementById('statusPill').textContent, rate: document.getElementById('miRate').textContent, state: document.getElementById('mainInd').dataset.state, src: window.__tapRate.app.source }));
  if (/TAPPING/.test(st.pill)) sawTapping = true;
  if (['ok', 'fast', 'slow'].includes(st.state) && /\d/.test(st.rate)) {
    if (!sawRate) await page.screenshot({ path: `${out}/02-demo-tapping.png` });
    sawRate = true;
  }
  if (sawRate && st.src === null) break;
}
check(sawTapping, 'demo: tap detected (TAPPING shown)');
check(sawRate, 'demo: main indicator showed a coloured rate');
await page.click('.tab[data-view="history"]');
await page.waitForTimeout(500);
const cards = await page.$$('.hcard');
check(cards.length >= 1, `history has the demo session (${cards.length})`);
await page.screenshot({ path: `${out}/03-history.png` });
if (cards.length) {
  await cards[0].click();
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/04-session.png`, fullPage: false });
  const txt = await page.textContent('#sesBody');
  check(/Tap 1/.test(txt) && /kg\/min/.test(txt), 'session detail shows per-tap stats');
  await page.click('#btnSesClose');
}
await page.click('.tab[data-view="settings"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${out}/05-settings.png`, fullPage: true });
check(errors.length === 0, `no runtime errors ${errors.join(' | ')}`);

await browser.close();
server.close();
process.exit(failed ? 1 : 0);
