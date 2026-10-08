// End-to-end test of the live camera path in headless Chromium.
// getUserMedia is replaced by a canvas stream showing a simulated crane-scale
// display (rendered in real time), so the whole chain runs:
//   <video> -> drawImage sampling -> seven-segment reader -> engine -> session -> History.
//   node tests/e2e/camera.mjs [outDir] [--low-power]
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { serve } from '../../tools/serve.mjs';

const require = createRequire(import.meta.url);
let playwright;
try { playwright = require('playwright'); } catch { playwright = require('/opt/node-tools/node_modules/playwright'); }

const lowPower = process.argv.includes('--low-power');
const out = process.argv.slice(2).find((a) => !a.startsWith('--')) || 'test-output';
mkdirSync(out, { recursive: true });
const server = await serve(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await playwright.chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.addInitScript(`window.__lowPower = ${lowPower};`);
await page.addInitScript(() => {
  localStorage.setItem('tapRate.settings.v1', JSON.stringify({ stallSec: 30, lostSec: 15, zoom: 1.4, resolution: '1080p', lowPower: window.__lowPower }));
  navigator.mediaDevices.getUserMedia = async (c) => {
    window.__constraints = c;
    const { renderDisplay } = await import('/js/vision/render7seg.js');
    const { TapSimulator } = await import('/js/analysis/sim.js');
    const W = 960, H = 540;
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const c2 = cv.getContext('2d');
    const img = c2.createImageData(W, H);
    const sim = new TapSimulator({ seed: 5, idleBefore: 12, tapMass: 1000, rate0: 1300, rateEnd: 1100, idleAfter: 60, touches: 1, touchDur: [3, 4], dropProb: 0, misreadProb: 0 });
    const t0 = performance.now();
    window.__sim = { sim, t0 };
    const draw = () => {
      const t = (performance.now() - t0) / 1000;
      renderDisplay(img.data, W, H, {
        text: String(sim.displayValue(t)), digitH: 30, cx: W / 2 + 25 * Math.sin(t * 0.8), cy: H / 2 + 10 * Math.sin(t * 1.3),
        slantDeg: 7, rotDeg: 1.5, noise: 3, glow: 0.35, seed: Math.floor(t * 10) + 1,
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

await page.goto(base);
await page.click('#btnCamera');
let ok = 0, n = 0, started = false, shot = false, dimmed = 0, fpsSum = 0, fpsN = 0;
for (let i = 0; i < 260; i++) {
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => {
    const a = window.__tapRate.app;
    return { ok: !!a.lastRes?.ok, src: a.source, sess: !!a.engine?.sess, pill: document.getElementById('statusPill').textContent, state: document.getElementById('mainInd').dataset.state, fps: a.fps, dim: document.getElementById('camBox').classList.contains('dim') };
  });
  n++; if (st.ok) ok++;
  if (st.dim) dimmed++;
  if (i >= 6) { fpsSum += st.fps; fpsN++; }
  if (st.sess) started = true;
  if (started && !shot && ['ok', 'fast', 'slow'].includes(st.state)) { await page.screenshot({ path: `${out}/cam-tapping${lowPower ? '-lowpower' : ''}.png` }); shot = true; }
  if (started && !st.sess) break;
}
check(ok / n > 0.8, `frames read successfully: ${ok}/${n}`);
const fps = fpsSum / Math.max(1, fpsN);
const asked = await page.evaluate(() => window.__constraints?.video);
if (lowPower) {
  // (3 a second when the page is idle; the simulated camera keeps this one busy)
  check(fps > 1.5 && fps < 3.6, `low power: at most 3 readings a second (${fps.toFixed(1)})`);
  check(asked?.frameRate?.max === 15 && asked?.height?.ideal === 1080, `low power: camera asked for 1080p at 15 frames/s (${JSON.stringify(asked?.frameRate)} ${asked?.height?.ideal})`);
  check(dimmed / n > 0.5, `low power: picture dimmed while reading (${dimmed}/${n} checks)`);
} else {
  check(fps > 5, `up to 10 readings a second (${fps.toFixed(1)})`);
  check(dimmed === 0, 'picture never dimmed');
}
check(started, 'session auto-started from the camera stream');
await page.waitForTimeout(1500);
const sessions = await page.evaluate(async () => (await window.__tapRate.store.all()).map((s) => ({ a: s.analysis, raw: s.raw.length, src: s.source })));
check(sessions.length === 1, `one session saved (${sessions.length})`);
if (sessions.length) {
  const seg = sessions[0].a.segments[0];
  const truth = await page.evaluate(() => window.__sim.sim.trueAvgRate);
  console.log(`   analysis: mass ${seg?.massKg} kg (true 1000), avg ${seg?.avgKgMin} kg/min (true ${truth.toFixed(0)}), raw frames ${sessions[0].raw}`);
  check(seg && Math.abs(seg.massKg - 1000) < 100, 'tapped mass within 100 kg');
  check(seg && Math.abs(seg.avgKgMin - truth) / truth < 0.1, 'average rate within 10%');
}
check(errors.length === 0, `no runtime errors ${errors.join(' | ')}`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
