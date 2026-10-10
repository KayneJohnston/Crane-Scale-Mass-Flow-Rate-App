// End-to-end test of the reader learning from the person (js/vision/learn.js) in headless
// Chromium. The camera is a canvas stream of a simulated display whose 5s glow in segment
// b, so they look like 9s: the reader can't read them, or misreads them (18,500 as 18,900).
//   node tests/e2e/learn.mjs [outDir]
// First the weight rises 50 kg every 3 s from 18,400 and the reader is on its own. Then,
// with the display holding 18,550, two corrections with ✎ teach it the shape of those 5s
// (Undo takes one back), kept on the phone. With the app opened again - the next run -
// the same rising weight is read right more often, and never wrong. A label in Review
// teaches too and a new label replaces it; "Forget learned shapes" clears it; no runtime
// errors.
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
page.on('dialog', (d) => d.accept());

const TRUTH = 18550;
await ctx.addInitScript(() => {
  localStorage.setItem('tapRate.settings.v1', JSON.stringify({ zoom: 1.4, resolution: '1080p', askMode: 'never' }));
  navigator.mediaDevices.getUserMedia = async () => {
    const rise = localStorage.getItem('e2e.display') !== 'hold';
    const { renderDisplay } = await import('/js/vision/render7seg.js');
    const W = 960, H = 540;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const t0 = performance.now();
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      const v = rise ? 18400 + 50 * Math.floor(t / 3) : 18550;
      if (v !== window.__shown) { window.__before = window.__shown; window.__changed = performance.now(); window.__shown = v; }
      renderDisplay(img.data, W, H, {
        text: String(v), digitH: 34, cx: W / 2 + 20 * Math.sin(t * 0.7), cy: H / 2, slantDeg: 7, noise: 3, glow: 0.35,
        seed: Math.floor(t * 10) + 1, faint: { 5: { b: 0.6 } },
      });
      c2.putImageData(img, 0, 0);
    };
    draw();
    setInterval(draw, 80);
    return cv.captureStream(15);
  };
});

let failed = false;
const check = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) failed = true; };
const fmt = (v) => v.toLocaleString('en-US');
const learned = async () => { await page.waitForFunction(() => window.__tapRate); return page.evaluate(() => window.__tapRate.memory.stats()); };
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('tapRate.learned.v1') || 'null'));

// every reading the app makes (what goes into the tap's data), from now on
async function record() {
  await page.waitForFunction(() => window.__tapRate?.app.engine);
  await page.evaluate(() => {
    const e = window.__tapRate.app.engine;
    window.__frames = [];
    const push = e.pushFrame.bind(e);
    // (with what the display shows, and what it showed until a moment ago: the frame read
    // may be a little older than the picture drawn last)
    e.pushFrame = (T, wall, v, conf, how) => {
      window.__frames.push([T, v, how, window.__shown, performance.now() - window.__changed < 400 ? window.__before : null]);
      return push(T, wall, v, conf, how);
    };
  });
}
// the readings of the rising weight in its first `sec` seconds
async function readings(sec) {
  await page.waitForFunction((s) => window.__frames.length && window.__frames.at(-1)[0] - window.__frames[0][0] >= s, sec, { timeout: (sec + 20) * 1000, polling: 200 });
  const f = await page.evaluate((s) => window.__frames.filter((r) => r[0] - window.__frames[0][0] < s && r[2] !== 'told'), sec);
  const right = (r) => r[1] === r[3] || r[1] === r[4];
  const wrong = f.filter((r) => r[1] != null && !right(r));
  return { n: f.length, right: f.filter(right).length, wrong: wrong.length, what: wrong.map((r) => `${r[3]} as ${r[1]} (${r[2]})`) };
}
const rate = (r) => `${r.right} of ${r.n} read right, ${r.wrong} wrong${r.wrong ? ': ' + [...new Set(r.what)].join(', ') : ''}`;

// tell the app the display shows TRUTH with ✎ (from the values offered, else "Other value")
async function correct() {
  await page.click('#btnCorrect');
  await page.waitForSelector('#askCard:not([hidden])', { timeout: 3000 });
  await page.waitForTimeout(400);
  const answers = await page.$$eval('#askAnswers button', (bs) => bs.map((b) => b.textContent));
  const k = answers.indexOf(fmt(TRUTH));
  if (k >= 0) await (await page.$$('#askAnswers button'))[k].click();
  else {
    if (answers.length) await page.click('#btnAskOther');
    for (let i = 0; i < 40; i++) {
      const v = +(await page.textContent('#askValue')).replace(/,/g, '');
      if (v === TRUTH) break;
      await page.click(`#askSteps button[data-steps="${Math.abs(v - TRUTH) >= 1000 ? (v < TRUTH ? 20 : -20) : v < TRUTH ? 1 : -1}"]`);
    }
    await page.click('#btnAskUse');
  }
  await page.waitForSelector('#askDone:not([hidden])', { timeout: 3000 });
}

// the first run: the reader alone
await page.goto(base);
await page.click('#btnCamera');
await record();
const before = await readings(20);
console.log(`   before: ${rate(before)}`);
await page.screenshot({ path: `${out}/learn-1.png` });

// teaching: the display holds 18,550
await page.click('#btnPower');
await page.evaluate(() => localStorage.setItem('e2e.display', 'hold'));
await page.reload();
await page.waitForFunction(() => window.__tapRate);
await page.click('#btnCamera');
await page.waitForTimeout(3000);
await correct();
const one = await learned();
check(one.answers === 1 && one.looks >= 1 && one.used === 0, `one correction: learned, not used yet (${JSON.stringify(one)})`);
await page.click('#btnAskUndo');
const undone = await learned();
check(undone.answers === 0 && undone.looks === 0, `Undo takes it back (${JSON.stringify(undone)})`);
if (await page.isVisible('#btnAskBack')) await page.click('#btnAskBack'); // ("Other value": back first)
await page.click('#btnAskClose');
await correct();
await page.waitForSelector('#askCard', { state: 'hidden', timeout: 8000 });
await correct();
await page.waitForSelector('#askCard', { state: 'hidden', timeout: 8000 });
const two = await learned();
check(two.answers === 2 && two.used >= 1, `two corrections: a digit shape in use (${JSON.stringify(two)})`);
check((await stored())?.looks?.length === two.looks, 'kept on the phone');

// the next run: the app opened again on the rising weight, nothing told this time
await page.click('#btnPower');
await page.evaluate(() => localStorage.setItem('e2e.display', 'rise'));
await page.reload();
check((await learned()).used === two.used, 'still there after the app is opened again');
await page.click('#btnCamera');
await record();
const after = await readings(20);
console.log(`   after:  ${rate(after)}`);
await page.screenshot({ path: `${out}/learn-2.png` });
check(after.wrong === 0, 'never read wrong after learning');
check(after.right > before.right || (before.wrong > 0 && after.right >= before.right), 'read right more often after learning');
await page.click('#btnPower');

// Review: a label teaches, a new label replaces it
await page.waitForTimeout(1000); // (a picture taken just before may still be being saved)
const cropIds = await page.evaluate(async () => (await window.__tapRate.crops.list()).filter((c) => c.label == null && c.lattices).map((c) => c.id));
if (cropIds.length) {
  await page.click('.tab[data-view="review"]');
  await page.waitForFunction(() => document.getElementById('reviewImg').naturalWidth > 0, null, { timeout: 10000 });
  const s0 = await learned();
  await page.fill('#reviewValue', String(TRUTH));
  await page.click('#reviewForm button[type="submit"]');
  await page.waitForFunction(async () => (await window.__tapRate.crops.list()).some((c) => c.label === 18550 && c.kind !== 'corrected'), null, { timeout: 5000 });
  const s1 = await learned();
  const c = await page.evaluate(async () => (await window.__tapRate.crops.list()).find((x) => x.label === 18550 && x.kind !== 'corrected'));
  check(s1.answers === s0.answers + (c.learnt ? 1 : 0), `a label in Review teaches (${s0.answers} -> ${s1.answers} answers)`);
  if (c.learnt) {
    // (the labelled pictures are shown in the order they are listed)
    const k = await page.evaluate(async (id) => (await window.__tapRate.crops.list()).filter((x) => x.label != null).findIndex((x) => x.id === id), c.id);
    await (await page.$$('.review-thumb'))[k].click();
    await page.waitForTimeout(300);
    await page.click('#btnReviewUnreadable');
    await page.waitForFunction(async (id) => (await window.__tapRate.crops.list()).find((x) => x.id === id)?.label === 'unreadable', c.id, { timeout: 5000 });
    const s2 = await learned();
    check(s2.answers === s0.answers, `a new label replaces what it taught (${s2.answers} answers)`);
  }
} else console.log('   (no unlabelled picture kept: Review labels not checked)');
await page.click('.tab[data-view="review"]');
await page.waitForTimeout(300);
const stats = await page.textContent('#reviewStats');
console.log(`   ${stats.split('\n').filter((l) => /Learned/.test(l)).join('')}`);
check(/Learned from your answers/.test(stats), 'Review says what was learned');
await page.screenshot({ path: `${out}/learn-3.png`, fullPage: true });
await page.click('#btnForgetLearned');
await page.waitForTimeout(300);
const gone = await learned();
check(gone.looks === 0 && (await stored())?.looks?.length === 0, 'Forget clears it, on the phone too');
check(errors.length === 0, `no runtime errors ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
