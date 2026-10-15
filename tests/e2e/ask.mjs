// End-to-end test of the live question "What does the display show?" in headless
// Chromium. The camera is a canvas stream of a simulated display whose middle digit is
// half hidden for 10 s of every 16 (as by fumes), so the reader can't tell.
//   node tests/e2e/ask.mjs [outDir]
// Checks: the question appears after ~3 s without a value, with a picture of the display
// then and three values, the differing digit marked; the answer about the picture -
// given after the display has moved on, as it does while metal pours - counts as a
// reading, and that picture goes to Review labelled with it; ✎ corrects a reading;
// "Not now" keeps it quiet; no runtime errors.
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

await page.addInitScript(() => {
  localStorage.setItem('tapRate.settings.v1', JSON.stringify({ zoom: 1.4, resolution: '1080p' }));
  navigator.mediaDevices.getUserMedia = async () => {
    const { renderDisplay } = await import('/js/vision/render7seg.js');
    const W = 960, H = 540;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const t0 = performance.now();
    // what the display shows from when ([s, kg], on the app's clock); __hard: the test
    // keeps the digit hidden, __hold: it stops the steps, __extra: it moves the display on
    window.__log = [];
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const hard = window.__hard ?? t % 16 > 6;
      const cx = W / 2 + 20 * Math.sin(t * 0.7);
      window.__shown = (window.__hold ?? 18000 + 50 * Math.floor(t / 6)) + (window.__extra || 0);
      if (window.__log.at(-1)?.[1] !== window.__shown) window.__log.push([performance.now() / 1000, window.__shown]);
      renderDisplay(img.data, W, H, { text: String(window.__shown), digitH: 34, cx, cy: H / 2, slantDeg: 7, noise: 3, glow: 0.35, seed: Math.floor(t * 10) + 1 });
      c2.putImageData(img, 0, 0);
      if (hard) { c2.fillStyle = 'rgb(26,22,24)'; c2.fillRect(cx - 14, H / 2 + 1, 26, 18); }
    };
    draw();
    setInterval(draw, 80);
    return cv.captureStream(15);
  };
});

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed = true; };
const fmt = (v) => v.toLocaleString('en-US');
const shown = () => page.evaluate(() => window.__shown);
const cardOpen = () => page.evaluate(() => !document.getElementById('askCard').hidden);

await page.goto(base);
await page.click('#btnCamera');
const tStart = Date.now();
await page.waitForSelector('#askCard:not([hidden])', { timeout: 25000 });
await page.evaluate(() => { window.__hard = true; window.__hold = window.__shown; }); // (until answered)
const waited = (Date.now() - tStart) / 1000;
console.log(`   asked after ${waited.toFixed(1)} s (display unclear from 6 s)`);
check(waited > 8 && waited < 13, 'asks about 3 s after the display became unclear');
await page.screenshot({ path: `${out}/ask-1.png` });
const answers = await page.$$eval('#askAnswers button', (bs) => bs.map((b) => b.textContent));
const marked = await page.$$eval('#askAnswers .hi', (s) => s.length);
console.log(`   offered ${answers.join(' / ')}, display shows ${fmt(await shown())}`);
// (the digits that differ are marked when there are one or two of them)
const digits = answers.map((a) => a.replace(/,/g, ''));
const n = Math.max(...digits.map((d) => d.length));
const differ = [...Array(n).keys()].filter((i) => digits.some((d) => d.padStart(n)[i] !== digits[0].padStart(n)[i])).length;
check(answers.length === 3 && (differ <= 2 ? marked >= 3 : marked === 0), `three values offered, ${differ <= 2 ? 'the differing digit marked' : 'too many digits differ to mark'}`);
check(/asking you/.test(await page.textContent('#readingBadge')), 'the reading says it is asking');

// The card shows the display as it was when the question appeared, and the question is
// about that picture. The display moves on before the tap (by 50 kg, as while metal
// pours): the answer is still what the picture showed.
const pic = await page.evaluate(() => {
  const s = window.__tapRate.asking.open?.snap, cv = document.querySelector('#askPic canvas');
  return { T: s?.T, w: cv?.width, h: cv?.height, shown: cv?.getBoundingClientRect().width || 0, title: document.getElementById('askTitle').textContent };
});
check(pic.T != null && pic.shown > 50 && /picture/.test(pic.title), `the card shows a picture of the display (${pic.w}x${pic.h}, "${pic.title}")`);
// (what the display showed a moment before the picture: the camera's frames lag a little)
const truth = await page.evaluate((T) => window.__log.filter((x) => x[0] <= T - 0.1).at(-1)[1], pic.T);
const tMoved = await page.evaluate(() => { window.__extra = 50; return performance.now() / 1000; });
await page.waitForTimeout(800);
console.log(`   the picture shows ${fmt(truth)}, the display now ${fmt(await shown())}`);
const k = answers.indexOf(fmt(truth));
if (k >= 0) await (await page.$$('#askAnswers button'))[k].click();
else {
  await page.click('#btnAskOther');
  for (let i = 0; i < 6; i++) {
    const v = +(await page.textContent('#askValue')).replace(/,/g, '');
    if (v === truth) break;
    await page.click(`#askSteps button[data-steps="${v < truth ? 1 : -1}"]`);
  }
  await page.click('#btnAskUse');
}
await page.waitForSelector('#askDone:not([hidden])', { timeout: 3000 });
await page.screenshot({ path: `${out}/ask-2.png` });
check((await page.textContent('#askDoneV')).includes(fmt(truth)), `answered ${fmt(truth)}`);
await page.waitForTimeout(800);
const told = await page.evaluate(() => {
  const e = window.__tapRate.app.engine;
  return [...(e.sess?.raw || []), ...(e.rawBuf || [])].filter((r) => r[3] === 'told').map((r) => r[1]);
});
check(told.includes(truth), `the answer counted as a reading (${told.join(', ')})`);
const asked = await page.evaluate(async () => (await window.__tapRate.crops.list()).filter((c) => c.kind === 'asked'));
check(asked.length === 1 && asked[0].label === truth, `its picture is in Review, labelled (${asked.map((c) => c.label).join(', ')})`);
check(asked.length === 1 && Math.abs(asked[0].t - pic.T) < 0.002 && asked[0].t < tMoved && asked[0].w === pic.w && asked[0].h === pic.h,
  `the picture kept is the one the card showed, from before the display moved on (${asked[0]?.t} < ${tMoved.toFixed(3)})`);
await page.waitForSelector('#askCard', { state: 'hidden', timeout: 8000 });
await page.evaluate(() => { window.__hard = undefined; });

// correcting a reading with the pencil
await page.click('#btnCorrect');
await page.waitForSelector('#askCard:not([hidden])', { timeout: 3000 });
const sub = await page.textContent('#askSub');
console.log(`   correcting: "${sub}"`);
check(/The app (reads|can’t read)/.test(sub), 'the correction says what the app reads');
await page.screenshot({ path: `${out}/ask-3.png` });
await page.waitForTimeout(400);
await (await page.$$('#askAnswers button'))[1].click();
await page.waitForSelector('#askDone:not([hidden])', { timeout: 3000 });
await page.click('#btnAskUndo');
check(await page.evaluate(() => !document.getElementById('askChoose').hidden), 'Undo goes back to the values');
await page.click('#btnAskClose');
check(!(await cardOpen()), 'closed with Not now');

// "Not now" during the next unclear spell keeps it quiet
await page.waitForSelector('#askCard:not([hidden])', { timeout: 40000 });
await page.waitForTimeout(400);
await page.click('#btnAskClose');
let reopened = false;
for (let i = 0; i < 16; i++) { await page.waitForTimeout(500); if (await cardOpen()) reopened = true; }
check(!reopened, 'no question for a while after Not now');
check(errors.length === 0, `no runtime errors ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
