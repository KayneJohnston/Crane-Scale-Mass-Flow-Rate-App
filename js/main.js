// Tap Rate — app controller (camera / video / demo -> reader -> engine -> UI).

import { loadSettings, saveSettings, resetSettings, SCHEMA, engineConfig, readerConfig, parseWindows, powerProfile } from './settings.js';
import { TapEngine, ENGINE_VERSION, reprocessSession } from './analysis/engine.js';
import { analyseSession, ANALYSIS_VERSION } from './analysis/offline.js';
import { TapSimulator } from './analysis/sim.js';
import { renderDisplay, mulberry32 } from './vision/render7seg.js';
import { Camera, WakeLock } from './camera.js';
import { BrowserReader } from './reader.js';
import { Store } from './store.js';
import { Beeper } from './audio.js';
import { TimeChart, COLORS, fmtClock, fmtInt, nearestIndex } from './ui/chart.js';
import { sessionCSV, rawCSV, summaryCSV, shareOrDownload, sessionFileBase } from './export.js';
import { CropStore, CropPolicy, CROP_DEFAULTS, cropRect, cropRecord, choicesFor, reviewOrder, reviewStats, exportFiles, cropsToDrop } from './crops.js';
import { makeZip } from './zip.js';

export const VERSION = '0.4.0';

const $ = (id) => document.getElementById(id);
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const kg = (v) => (v == null || !Number.isFinite(v) ? '—' : fmtInt(v));

let settings = loadSettings();
const store = new Store();
const beeper = new Beeper();
const wake = new WakeLock();
const reader = new BrowserReader();
const video = $('video'), simCanvas = $('simCanvas'), overlay = $('overlay'), camBox = $('camBox');
const camera = new Camera(video);
const crops = new CropStore();
const cropPolicy = new CropPolicy();

const app = {
  source: null,               // null | 'camera' | 'video' | 'demo'
  el: video,                  // element the reader samples
  engine: null,
  lastRes: null,
  view: { cx: 0.5, cy: 0.5, z: 1 },
  zoomTotal: 1, hwZoom: 1, hwBusy: false,
  meta: blankMeta(),
  liveSpan: 180,
  demo: null,
  vid: null,
  lastProc: 0, lastUi: 0, lastChart: 0, lastSave: 0,
  foundAt: 0,                 // when the display was last located
  okSince: null, failSince: null, undimUntil: 0, // low power mode: dimming the camera picture
  frames: 0, fpsT: 0, fps: 0,
  alarm: { state: null, since: 0, lastBeep: 0 },
  lastSnap: null,
};

function blankMeta() {
  const l = settings.lastMeta || {};
  return { pots: '', crucible: l.crucible || '', crew: l.crew || '', operator: l.operator || '', notes: '' };
}

// ------------------------------------------------------------ engine --

function makeEngine() {
  const eng = new TapEngine(engineConfig(settings), {
    onSessionStart: () => {
      beeper.play('start');
      toast('Tap detected — recording');
      app.lastSave = 0;
    },
    onSessionEnd: (out) => finishSession(out),
  });
  return eng;
}

async function finishSession(out) {
  out.source = app.source || 'camera';
  out.meta = { ...app.meta };
  out.analysis = analyseSession(out);
  const tot = out.analysis.totals;
  app.meta = blankMeta();
  beeper.play('end');
  const keep = tot.taps > 0 && !(out.source === 'demo' && !settings.saveDemo);
  if (keep) {
    await store.put(out);
    const v = tot.verdict === 'fast' ? 'too fast' : tot.verdict === 'slow' ? 'too slow' : 'on target';
    toast(`Saved: +${kg(tot.massKg)} kg in ${fmtClock(tot.flowSec)} · avg ${kg(tot.avgKgMin)} kg/min (${v})`, 6000);
    renderHistory();
    if (!out.meta.pots && out.source === 'camera') setTimeout(() => openMeta(out), 600);
  } else {
    if (out.id) store.delete(out.id).catch(() => {});
    if (tot.taps === 0) toast('Recording ended — no tap found, not saved');
  }
}

async function saveActive() {
  const eng = app.engine;
  if (!eng?.sess) return;
  if (app.source === 'demo' && !settings.saveDemo) return;
  const out = eng.exportSession();
  out.source = app.source; out.meta = { ...app.meta }; out.status = 'active';
  try { await store.put(out); } catch (e) { console.warn('save failed', e); }
}

// ------------------------------------------------------ view / zoom --

function srcDims() {
  if (app.el === simCanvas) return [simCanvas.width, simCanvas.height];
  return [video.videoWidth || 1280, video.videoHeight || 720];
}

function viewRect() {
  const [sw, sh] = srcDims();
  const bw = camBox.clientWidth || 1, bh = camBox.clientHeight || 1;
  const s = Math.max(bw / sw, bh / sh) * app.view.z;
  const w = Math.min(sw, bw / s), h = Math.min(sh, bh / s);
  const x = clamp(app.view.cx * sw - w / 2, 0, sw - w), y = clamp(app.view.cy * sh - h / 2, 0, sh - h);
  app.view.cx = (x + w / 2) / sw; app.view.cy = (y + h / 2) / sh;
  return { x, y, w, h, s, sw, sh };
}

function applyView() {
  const v = viewRect();
  const el = app.el;
  // element sized to the "cover" fit; zoom is a compositor-only scale (no huge layers on iOS)
  const s0 = v.s / app.view.z;
  el.style.width = `${v.sw * s0}px`;
  el.style.height = `${v.sh * s0}px`;
  el.style.transform = `translate(${-v.x * v.s}px, ${-v.y * v.s}px) scale(${app.view.z})`;
}

let hwTimer = null;
function setZoom(Z, { persist = true } = {}) {
  const caps = settings.hwZoom && app.source === 'camera' ? camera.zoomCaps() : null;
  Z = clamp(Z, 1, maxZoom());
  app.zoomTotal = Z;
  if (caps) {
    const hw = clamp(Z, Math.max(1, caps.min), caps.max);
    if (Math.abs(hw - app.hwZoom) > 0.02) {
      app.hwZoom = hw;
      clearTimeout(hwTimer);
      hwTimer = setTimeout(() => camera.setZoom(app.hwZoom), 60);
    }
    app.view.z = Z / app.hwZoom;
  } else {
    app.hwZoom = 1;
    app.view.z = Z;
  }
  $('zoom').value = Z;
  $('zoomLabel').textContent = `${Z.toFixed(1)}×`;
  applyView();
  if (persist) { settings.zoom = Z; saveSettings(settings); }
}

function maxZoom() {
  const caps = settings.hwZoom && app.source === 'camera' ? camera.zoomCaps() : null;
  return Math.max(12, caps ? Math.min(caps.max, 30) * 3 : 12);
}

function setupGestures() {
  const pts = new Map();
  let pinch = null, pan = null, lastTap = 0;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  camBox.addEventListener('pointerdown', (e) => {
    app.undimUntil = performance.now() + 15000;
    camBox.classList.remove('dim');
    if (e.target.closest('.cam-zoom, .cam-start')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    camBox.setPointerCapture?.(e.pointerId);
    if (pts.size === 1) {
      const now = performance.now();
      if (now - lastTap < 300) { app.view.cx = 0.5; app.view.cy = 0.5; setZoom(1); lastTap = 0; return; }
      lastTap = now;
      pan = { x: e.clientX, y: e.clientY, cx: app.view.cx, cy: app.view.cy };
    }
    if (pts.size === 2) { pinch = { d0: dist(), z0: app.zoomTotal }; pan = null; }
  });
  camBox.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) setZoom((pinch.z0 * dist()) / Math.max(1, pinch.d0), { persist: false });
    else if (pan && pts.size === 1) {
      const v = viewRect();
      app.view.cx = pan.cx - (e.clientX - pan.x) / v.s / v.sw;
      app.view.cy = pan.cy - (e.clientY - pan.y) / v.s / v.sh;
      applyView();
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2 && pinch) { pinch = null; setZoom(app.zoomTotal); }
    if (!pts.size) pan = null;
  };
  camBox.addEventListener('pointerup', up);
  camBox.addEventListener('pointercancel', up);
  $('zoom').addEventListener('input', (e) => setZoom(+e.target.value));
  window.addEventListener('resize', () => { applyView(); app.lastChart = 0; });
  video.addEventListener('resize', () => applyView()); // intrinsic size changed (rotation, lens switch)
}

// ------------------------------------------------------------ sources --

async function startCamera() {
  beeper.unlock();
  await stopSources();
  setPill('Starting camera…', 'busy');
  try {
    const P = powerProfile(settings);
    const info = await camera.start({ deviceId: settings.deviceId, resolution: P.resolution, fps: P.camFps });
    app.source = 'camera';
    app.foundAt = performance.now();
    useElement(video);
    app.engine = makeEngine();
    reader.resetTracking();
    cropPolicy.reset();
    $('camStart').hidden = true;
    wake.request();
    app.hwZoom = 1;
    $('zoom').max = String(maxZoom());
    setZoom(settings.zoom || 1);
    populateCameras();
    updateControls();
    toast(`Camera ${info.width}×${info.height}${camera.zoomCaps() ? ' · lens zoom available' : ''}`);
  } catch (e) {
    console.error(e);
    setPill('Camera off', 'warn');
    toast(`Camera error: ${e.message || e.name}. Allow camera access for this site in Settings › Safari › Camera.`, 7000);
  }
}

// A new camera stream with the current lens, resolution and power settings, keeping
// the tap being recorded and what the reader knows about the display. One at a time:
// overlapping restarts would leave an orphaned stream running.
let camRestart = Promise.resolve();
function restartCamera() {
  camRestart = camRestart.then(restartCameraNow);
  return camRestart;
}

async function restartCameraNow() {
  if (app.source !== 'camera') return;
  const P = powerProfile(settings);
  try {
    await camera.start({ deviceId: settings.deviceId, resolution: P.resolution, fps: P.camFps });
    app.hwZoom = 1;
    $('zoom').max = String(maxZoom());
    setZoom(app.zoomTotal, { persist: false });
    populateCameras();
  } catch (e) {
    console.error(e);
    toast(`Camera error: ${e.message || e.name}`, 6000);
    stopSources();
  }
}

function useElement(el) {
  app.el = el;
  video.hidden = el !== video;
  simCanvas.hidden = el !== simCanvas;
  applyView();
}

async function stopSources({ keepUi = false } = {}) {
  if (app.vid?.running) { app.vid.cancel = true; while (app.vid?.running) await new Promise((r) => setTimeout(r, 50)); }
  if (app.engine?.sess) app.engine.endSession('manual');
  camera.stop();
  if (video.src) { URL.revokeObjectURL(video.src); video.removeAttribute('src'); video.load(); }
  app.demo = null; app.vid = null; app.source = null; app.engine = null; app.lastRes = null;
  app.okSince = app.failSince = null;
  camBox.classList.remove('dim');
  wake.release();
  if (!keepUi) {
    $('camStart').hidden = false;
    $('camProgress').hidden = true;
    $('readingBadge').hidden = true;
    clearOverlay();
    setPill('Camera off', 'idle');
    updateControls();
  }
}

// --- video file ---

function seekTo(v, t) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true; v.removeEventListener('seeked', onSeek); clearTimeout(to);
      if (v.requestVideoFrameCallback) {
        const t2 = setTimeout(resolve, 120);
        v.requestVideoFrameCallback(() => { clearTimeout(t2); resolve(); });
      } else resolve();
    };
    const onSeek = () => fin();
    const to = setTimeout(fin, 4000);
    v.addEventListener('seeked', onSeek);
    v.currentTime = t;
  });
}

async function loadVideo(file) {
  beeper.unlock();
  await stopSources({ keepUi: true });
  app.source = 'video';
  useElement(video);
  video.srcObject = null;
  video.muted = true; video.playsInline = true;
  video.src = URL.createObjectURL(file);
  try {
    await new Promise((res, rej) => { video.onloadedmetadata = res; video.onerror = () => rej(new Error('Cannot open this video')); });
    try { await video.play(); } catch { /* fine */ }
    video.pause();
    await seekTo(video, Math.min(video.duration / 2, 2));
  } catch (e) {
    toast(e.message); await stopSources(); return;
  }
  app.vid = { file, running: false, cancel: false, progress: 0 };
  app.engine = makeEngine();
  reader.resetTracking();
  $('camStart').hidden = true;
  $('zoom').max = '12';
  setZoom(1, { persist: false });
  showView('live');
  updateControls();
  toast('Pinch/drag so the digits are in view, then press “Analyse video”.', 6000);
}

async function runVideo() {
  const v = app.vid;
  if (!v || v.running) return;
  v.running = true; v.cancel = false;
  app.engine = makeEngine();
  reader.resetTracking();
  cropPolicy.reset();
  updateControls();
  const dur = video.duration;
  const fps = powerProfile(settings).videoFps;
  const wall0 = (v.file.lastModified || Date.now()) - dur * 1000;
  $('camProgress').hidden = false;
  let i = 0, lastT = -Infinity;
  const handle = (t) => {
    processFrame(video, video.videoWidth, video.videoHeight, t, wall0 + t * 1000);
    app.engine.tick(t);
    v.progress = dur ? t / dur : 0;
    if (i++ % 4 === 0) {
      $('camProgressBar').style.width = `${(100 * v.progress).toFixed(1)}%`;
      renderLive(true);
    }
  };
  if (video.requestVideoFrameCallback) {
    // play (2x) and read the frames as they are presented: much faster than seeking on iOS
    await seekTo(video, 0);
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; video.pause(); video.onended = null; resolve(); } };
      const onFrame = (_now, meta) => {
        if (done) return;
        if (v.cancel) { finish(); return; }
        const t = meta.mediaTime;
        if (t - lastT >= 1 / fps - 1e-3) { lastT = t; handle(t); }
        video.requestVideoFrameCallback(onFrame);
      };
      video.onended = finish;
      video.playbackRate = 2;
      video.requestVideoFrameCallback(onFrame);
      video.play().catch(() => finish());
    });
    video.playbackRate = 1;
  } else {
    for (let t = 0; t <= dur && !v.cancel; t += 1 / fps) {
      await seekTo(video, t);
      handle(t);
      if (i % 4 === 0) await new Promise((r) => requestAnimationFrame(r));
    }
  }
  if (app.engine?.sess) app.engine.endSession(v.cancel ? 'cancelled' : 'video-end', Math.min(dur, app.engine.lastT));
  v.running = false;
  $('camProgress').hidden = true;
  updateControls();
  renderLive(true);
  toast(v.cancel ? 'Video analysis stopped' : 'Video analysed — see History');
}

// --- demo ---

function startDemo(speed, fixedSeed = 0) {
  beeper.unlock();
  stopSources({ keepUi: true }).then(() => {
    const seed = fixedSeed || 1 + Math.floor(Math.random() * 100000);
    const rand = mulberry32(seed * 13 + 1);
    const twoPots = rand() < 0.35;
    const sim = new TapSimulator({
      seed,
      rate0: 800 + rand() * 500,
      rateEnd: 520 + rand() * 200,
      taps: twoPots ? [{ mass: 3600 }, { mass: 3200 + rand() * 600, rate0: 650 + rand() * 300 }] : null,
      gapSec: 50,
    });
    app.source = 'demo';
    app.demo = { sim, speed, t: 0, next: 0, last: performance.now(), wall0: Date.now(), lastRender: 0, img: null };
    useElement(simCanvas);
    app.engine = makeEngine();
    reader.resetTracking();
    $('camStart').hidden = true;
    $('zoom').max = '12';
    setZoom(1.6, { persist: false });
    showView('live');
    updateControls();
    toast(`Demo ${speed}× — simulated ${twoPots ? 'two-pot crucible' : 'tap'} with noise, touches and misreads`, 5000);
  });
}

function renderSim(t) {
  const d = app.demo;
  const ctx = simCanvas.getContext('2d');
  const W = simCanvas.width, H = simCanvas.height;
  if (!d.img) d.img = ctx.createImageData(W, H);
  const k = Math.floor(t * 10);
  renderDisplay(d.img.data, W, H, {
    text: String(d.sim.displayValue(t)), digitH: 34,
    cx: W / 2 + 14 * Math.sin(t * 0.9) + 5 * Math.sin(t * 3.1), cy: H / 2 + 9 * Math.sin(t * 1.3 + 1),
    slantDeg: 8, rotDeg: 2 * Math.sin(t * 0.5), noise: 5, glow: 0.4, blur: 1, seed: k + 1,
    glare: [{ x: W * 0.62, y: H * 0.42, r: 26, i: 70 + 40 * Math.sin(t * 0.3) }],
    clutter: [{ x: W * 0.15, y: H * 0.8, r: 9, color: [190, 40, 30] }],
  });
  ctx.putImageData(d.img, 0, 0);
}

function stepDemo(now) {
  const d = app.demo;
  const dtReal = Math.min(0.25, (now - d.last) / 1000);
  d.last = now;
  const tEnd = d.t + dtReal * d.speed;
  const step = 1 / clamp(+settings.procFps || 10, 2, 20);
  while (d.next <= tEnd) {
    const t = d.next;
    if (d.speed === 1) {
      renderSim(t);
      processFrame(simCanvas, simCanvas.width, simCanvas.height, t, d.wall0 + t * 1000);
    } else {
      const f = d.sim.frame(t);
      app.engine.pushFrame(t, d.wall0 + t * 1000, f.value, f.conf);
    }
    d.next += step;
  }
  d.t = tEnd;
  app.engine.tick(d.t);
  if (d.speed !== 1 && now - d.lastRender > 200) { renderSim(d.t); d.lastRender = now; }
  if (d.t > d.sim.duration + 5) {
    if (app.engine.sess) app.engine.endSession('demo-end');
    toast('Demo finished');
    stopSources();
  }
}

// ---------------------------------------------------------- processing --

function processFrame(el, w, h, T, wall) {
  if (!w || !h) return;
  const view = viewRect();
  // where the tap engine expects the weight: helps the reader through unclear frames
  const expect = app.engine?.expectation(T);
  const res = reader.read(el, w, h, view, { ...readerConfig(settings), keepDebug: !!settings.debug, expect }, T);
  app.lastRes = res;
  collectCrop(res, el, w, h, T, wall);
  if (res.located) app.foundAt = performance.now();
  app.engine.pushFrame(T, wall, res.ok ? res.value : null, res.conf, res.how);
  app.frames++;
  drawOverlay(res, view);
  updateDim(res);
  if (settings.debug) drawDebug(res);
}

// readings per second from the camera: fewer while the display is out of view
function camFps(P, now) {
  return now - app.foundAt > 5000 ? P.searchFps : P.procFps;
}

function loop() {
  const P = powerProfile(settings);
  try { tick(P); } finally { scheduleLoop(P); }
}

// Normally the loop runs with the screen's refresh. With nothing to show it idles, and
// in low power mode it wakes only when a reading or a screen update is due.
function scheduleLoop(P) {
  if (app.source === 'demo' || (app.source && !P.low)) { requestAnimationFrame(loop); return; }
  const now = performance.now();
  let due = app.lastUi + (app.source ? P.uiMs : 500);
  if (app.source === 'camera') due = Math.min(due, app.lastProc + 1000 / camFps(P, now));
  setTimeout(loop, clamp(due - now, 15, 1000));
}

function tick(P) {
  const now = performance.now();
  if (app.source === 'camera' && camera.active && video.videoWidth) {
    if (now - app.lastProc >= 1000 / camFps(P, now) - 2) {
      app.lastProc = now;
      processFrame(video, video.videoWidth, video.videoHeight, now / 1000, Date.now());
    }
    app.engine.tick(now / 1000);
  } else if (app.source === 'demo' && app.demo) stepDemo(now);
  if (now - app.fpsT >= 1000) { app.fps = app.frames * 1000 / (now - app.fpsT); app.frames = 0; app.fpsT = now; }
  if (app.vid?.running) return; // video loop renders itself
  if (now - app.lastUi >= P.uiMs - 2) { app.lastUi = now; renderLive(now - app.lastChart >= P.chartMs - 2); }
  if (app.engine?.sess && app.source !== 'video' && now - app.lastSave > P.saveMs) { app.lastSave = now; saveActive(); }
}

// Low power mode dims the camera picture once the display has been read for a few
// seconds (the green box and reading stay visible): on an OLED screen dark pixels draw
// almost no power. It comes back while the display can't be read, and for 15 s after
// the picture is touched.
function updateDim(res) {
  const now = performance.now();
  if (res.ok) { app.okSince ??= now; app.failSince = null; }
  else { app.failSince ??= now; if (now - app.failSince > 2000) app.okSince = null; }
  const dim = !!settings.lowPower && app.source === 'camera' && app.okSince != null && now - app.okSince > 3000 && now > app.undimUntil;
  camBox.classList.toggle('dim', dim);
}

function syncPower() {
  const low = !!settings.lowPower;
  $('btnLowPower').classList.toggle('on', low);
  document.body.classList.toggle('low-power', low);
  if (!low) camBox.classList.remove('dim');
}

// ------------------------------------------------------- review crops --

const review = { count: { total: 0, todo: 0 }, full: false, cur: null, edit: null, skipped: new Set(), urls: [], test: null };

// Keep a crop of the display from a hard frame for the Review tab (crops.js): from the
// camera or a video only, at most one of a kind every few seconds.
function collectCrop(res, el, w, h, T, wall) {
  if (!settings.collectCrops || (app.source !== 'camera' && app.source !== 'video') || review.full) return;
  const kind = cropPolicy.consider(res, T);
  if (!kind) return;
  const rect = cropRect(res.located, w, h);
  if (!rect) return;
  const cv = document.createElement('canvas');
  cv.width = rect.outW; cv.height = rect.outH;
  const ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(el, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.outW, rect.outH);
  const meta = cropRecord(res, kind, { t: T, wall, source: app.source, rect });
  cv.toBlob(async (blob) => {
    if (!blob) return;
    try {
      await crops.add(meta, await blobBytes(blob));
      review.count.total++; review.count.todo++;
      if (review.count.total > CROP_DEFAULTS.maxCrops) await trimCrops();
      updateReviewBadge();
    } catch (e) { console.warn('crop not kept', e); }
  }, 'image/png');
}

const blobBytes = (b) => (b.arrayBuffer ? b.arrayBuffer() : new Response(b).arrayBuffer());

// at most maxCrops: the oldest unlabelled go first, labelled ones are never dropped
async function trimCrops() {
  const all = await crops.list();
  const drop = cropsToDrop(all, CROP_DEFAULTS.maxCrops);
  await crops.delete(drop);
  countCrops(all.filter((c) => !drop.includes(c.id)));
}

function countCrops(list) {
  const todo = list.filter((c) => c.label == null).length;
  review.count = { total: list.length, todo };
  review.full = list.length >= CROP_DEFAULTS.maxCrops && todo === 0; // all labelled: export and delete some
}

function updateReviewBadge() {
  const b = $('reviewBadge'), n = review.count.todo;
  b.hidden = !n;
  b.textContent = n > 99 ? '99+' : String(n);
}

function pngUrl(buf) {
  const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
  review.urls.push(url);
  return url;
}

function freeUrls() {
  for (const u of review.urls) URL.revokeObjectURL(u);
  review.urls = [];
}

async function renderReview() {
  const list = await crops.list();
  countCrops(list);
  updateReviewBadge();
  freeUrls();
  const queue = reviewOrder(list).filter((c) => !review.skipped.has(c.id));
  const cur = (review.edit && list.find((c) => c.id === review.edit)) || queue[0] || null;
  review.edit = null;
  await showCrop(cur);
  renderReviewStats(list);
  await renderReviewGrid(list);
  $('reviewStats').hidden = $('reviewFoot').hidden = !list.length;
}

function describeCrop(c) {
  const lines = [];
  if (c.kind === 'unsure') lines.push(`Given as ≈${fmtInt(c.value)} kg, ${probText(c.conf ?? 0)} probable`);
  else if (c.kind === 'sample') lines.push(`Read clearly as ${fmtInt(c.value)} kg`);
  else if (c.kind === 'refused') lines.push(`Read ${c.strict != null ? fmtInt(c.strict) + ' kg' : 'something'}, not believed (${c.how === 'digit-slip' ? 'a digit lost?' : 'far from the readings before'})`);
  else lines.push('Couldn’t read it');
  if (c.kind !== 'unsure' && c.kind !== 'sample' && c.candidates?.length) {
    lines.push(`Most probable: ${c.candidates.map((x) => `${fmtInt(x.v)} (${probText(x.p)})`).join(', ')}`);
  }
  const d = new Date(c.wall);
  lines.push(`${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} · ${c.source === 'video' ? 'video' : 'camera'}`);
  if (c.label != null) lines.push(`You said: ${c.label === 'unreadable' ? 'can’t tell' : fmtInt(c.label) + ' kg'}`);
  return lines;
}

async function showCrop(c) {
  review.cur = c;
  $('reviewCard').hidden = !c;
  const empty = $('reviewEmpty');
  empty.hidden = !!c;
  if (!c) {
    empty.textContent = review.count.total ? 'All done: nothing left to label.'
      : settings.collectCrops ? 'Nothing to review yet. Hard frames are kept while the camera or a video is being read.'
        : 'Keeping hard frames is off (Settings › Camera & vision).';
    return;
  }
  const buf = await crops.image(c.id);
  $('reviewImg').src = buf ? pngUrl(buf) : '';
  const meta = $('reviewMeta');
  meta.replaceChildren();
  describeCrop(c).forEach((t, i) => {
    const el = document.createElement(i === 0 ? 'strong' : 'div');
    el.textContent = t;
    meta.appendChild(el);
  });
  const box = $('reviewChoices');
  box.replaceChildren();
  for (const v of choicesFor(c, +settings.stepKg || 50)) {
    const b = document.createElement('button');
    b.className = 'btn'; b.type = 'button'; b.textContent = fmtInt(v);
    b.addEventListener('click', () => labelCrop(c, v));
    box.appendChild(b);
  }
  $('reviewValue').value = typeof c.label === 'number' ? c.label : '';
}

async function labelCrop(c, label) {
  c.label = label;
  c.labelledAt = Date.now();
  await crops.update(c);
  review.skipped.delete(c.id);
  await renderReview();
}

function renderReviewStats(list) {
  const s = reviewStats(list);
  const lines = [`${s.todo} to label · ${s.labelled} labelled${s.unreadable ? ` (${s.unreadable} can’t tell)` : ''}`];
  if (s.guessed) lines.push(`Most probable value given: right ${s.guessedRight} of ${s.guessed} times`);
  if (s.clear) lines.push(`Clear readings: right ${s.clearRight} of ${s.clear}`);
  if (s.withTop) lines.push(`Not read or not believed: the most probable value was right ${s.topRight} of ${s.withTop} times`);
  const T = review.test;
  if (T) lines.push(`Reader test on ${T.n} labelled pictures: ${T.ok} read right, ${T.none} not read, ${T.wrong} misread`);
  if (review.full) lines.push(`Storage full (${CROP_DEFAULTS.maxCrops} pictures, all labelled): export them, then delete them to keep collecting.`);
  $('reviewStats').textContent = lines.join('\n');
}

async function renderReviewGrid(list) {
  const done = list.filter((c) => c.label != null).slice(0, 30);
  $('reviewDone').hidden = !done.length;
  const grid = $('reviewGrid');
  grid.replaceChildren();
  for (const c of done) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'review-thumb' + (c.value != null && c.value !== c.label ? ' miss' : ''); // the app gave another value
    const img = document.createElement('img');
    img.alt = '';
    const buf = await crops.image(c.id);
    if (buf) img.src = pngUrl(buf);
    const t = document.createElement('span');
    t.textContent = c.label === 'unreadable' ? 'can’t tell' : fmtInt(c.label);
    b.append(img, t);
    b.addEventListener('click', () => { review.edit = c.id; renderReview(); $('view-review').scrollTop = 0; });
    grid.appendChild(b);
  }
}

// "20.05" (tonnes) -> 20050; "20050" -> 20050
function parseKg(text) {
  const t = String(text).trim().replace(',', '.');
  if (!t) return null;
  const x = +t;
  if (!Number.isFinite(x) || x <= 0) return null;
  return t.includes('.') ? Math.round(x * 1000) : Math.round(x);
}

async function submitReviewValue() {
  const c = review.cur;
  if (!c) return;
  const v = parseKg($('reviewValue').value);
  if (v == null) { toast('Type the value the display showed, in kg'); return; }
  const step = +settings.stepKg || 0;
  if (step && v % step && !confirm(`${fmtInt(v)} kg is not a multiple of ${step} kg. Save it anyway?`)) return;
  $('reviewValue').blur();
  await labelCrop(c, v);
}

async function exportCrops() {
  const list = await crops.list();
  if (!list.length) { toast('Nothing to export yet'); return; }
  toast('Preparing the pictures…');
  const images = new Map();
  for (const c of list) {
    const b = await crops.image(c.id);
    if (b) images.set(c.id, new Uint8Array(b));
  }
  const about = { version: VERSION, display: { minKg: +settings.minKg, maxKg: +settings.maxKg, stepKg: +settings.stepKg, multiplier: +settings.multiplier } };
  const zip = makeZip(exportFiles(list, images, about));
  await shareOrDownload(`tap-rate-review-${datestamp()}.zip`, zip, 'application/zip');
}

function loadImage(buf) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('picture damaged')); };
    img.src = url;
  });
}

// How the reader, as it is now, does on the labelled pictures (each on its own, no history).
async function testReaderOnCrops() {
  const list = (await crops.list()).filter((c) => typeof c.label === 'number');
  if (!list.length) { toast('Label some pictures first'); return; }
  toast(`Reading ${list.length} pictures…`);
  const rd = new BrowserReader();
  const cfg = { ...readerConfig(settings), temporal: false };
  const T = { n: 0, ok: 0, none: 0, wrong: 0 };
  for (const c of list) {
    const buf = await crops.image(c.id);
    if (!buf) continue;
    try {
      const { img, url } = await loadImage(buf);
      rd.resetTracking();
      const w = img.naturalWidth, h = img.naturalHeight;
      const r = rd.read(img, w, h, { x: 0, y: 0, w, h }, cfg, null);
      URL.revokeObjectURL(url);
      T.n++;
      if (!r.ok) T.none++; else if (r.value === c.label) T.ok++; else T.wrong++;
    } catch (e) { console.warn(e); }
    await new Promise((res) => setTimeout(res, 0));
  }
  review.test = T;
  renderReviewStats(await crops.list());
  toast(`${T.ok} of ${T.n} read right, ${T.none} not read, ${T.wrong} misread`, 5000);
}

async function clearCrops() {
  const list = await crops.list();
  if (!list.length) { toast('Nothing to delete'); return; }
  if (!confirm(`Delete all ${list.length} pictures kept for review, labelled ones too? Export them first to keep them.`)) return;
  await crops.delete(list.map((c) => c.id));
  review.skipped.clear();
  review.test = null;
  await renderReview();
  toast('Deleted');
}

// ------------------------------------------------------------ overlay --

function clearOverlay() {
  const ctx = overlay.getContext('2d');
  ctx.clearRect(0, 0, overlay.width, overlay.height);
}

function drawOverlay(res, v) {
  const dpr = window.devicePixelRatio || 1;
  const W = camBox.clientWidth, H = camBox.clientHeight;
  if (overlay.width !== Math.round(W * dpr) || overlay.height !== Math.round(H * dpr)) {
    overlay.width = Math.round(W * dpr); overlay.height = Math.round(H * dpr);
  }
  const ctx = overlay.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const map = ([x, y]) => [(x - v.x) * v.s, (y - v.y) * v.s];
  if (res.located) {
    const L = res.located;
    const [x0, y0] = map([L.x, L.y]), [x1, y1] = map([L.x + L.w, L.y + L.h]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = res.ok ? '#30d158' : '#ffcc00';
    ctx.strokeRect(x0 - 4, y0 - 4, x1 - x0 + 8, y1 - y0 + 8);
    if (res.ok && res.quads) {
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(48,209,88,0.7)';
      for (const q of res.quads) {
        ctx.beginPath();
        q.map(map).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.closePath(); ctx.stroke();
      }
    }
  }
  const b = $('readingBadge');
  b.hidden = false;
  // "≈": an unclear frame resolved using the value expected from the previous readings,
  // with how probable that value is
  if (res.ok) { b.textContent = res.how === 'prior' ? `≈${fmtInt(res.value)} kg · ${probText(res.conf)}` : `${fmtInt(res.value)} kg`; b.classList.remove('bad'); }
  else { b.textContent = reasonText(res); b.classList.add('bad'); }
}

// 0.9973 -> "99.7%"; never rounds up to 100%
function probText(p) {
  const d = p >= 0.99 ? 1 : 0;
  return `${(Math.floor(p * 100 * 10 ** d) / 10 ** d).toFixed(d)}%`;
}

function reasonText(res) {
  const r = res.reason || '';
  if (r === 'locking') return 'Locking on…';
  if (r === 'jump-pending') return `Checking ${res.strict != null ? fmtInt(res.strict) : 'jump'}…`;
  if (r === 'digit-slip') return `Ignoring ${res.strict != null ? fmtInt(res.strict) : 'reading'} — digit lost?`;
  if (r === 'no-display' || r === 'not-found') return 'Looking for red digits…';
  if (r.startsWith('invalid-range')) return `Out of range (${res.text || '?'})`;
  if (r.startsWith('invalid-step')) return `Not a ${settings.stepKg} kg step (${res.text})`;
  if (r.startsWith('invalid-digits')) return `Wrong digit count (${res.text || '?'})`;
  if (r === 'edge') return 'Digits cut off — re-centre';
  if (r === 'small') return 'Too small — zoom in';
  return 'Can’t read clearly';
}

function drawDebug(res) {
  const d = res.debug?.read;
  const c1 = $('dbgCrop'), c2 = $('dbgMask');
  if (d) {
    c1.width = d.w; c1.height = d.h;
    c1.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(d.img), d.w, d.h), 0, 0);
    const m = d.res.mask;
    if (m) {
      c2.width = m.w; c2.height = m.h;
      const img = new ImageData(m.w, m.h);
      for (let i = 0; i < m.w * m.h; i++) {
        const on = m.data[i] > m.T;
        img.data[i * 4] = on ? 255 : m.data[i] / 3;
        img.data[i * 4 + 1] = on ? 255 : m.data[i] / 4;
        img.data[i * 4 + 2] = on ? 255 : m.data[i] / 4;
        img.data[i * 4 + 3] = 255;
      }
      c2.getContext('2d').putImageData(img, 0, 0);
    }
  }
  const r = d?.res;
  const lines = [
    `result: ${res.ok ? 'OK ' + res.value : 'fail (' + res.reason + ')'}  text "${res.text ?? ''}"  mode ${res.mode ?? ''}`,
    `digit height ${res.digitHpx ? res.digitHpx.toFixed(1) + ' px (source)' : '—'}  rot ${r ? r.rotDeg.toFixed(1) : '—'}°  slant ${r ? r.shear.toFixed(2) : '—'}`,
    `threshold ${r ? r.threshold.toFixed(0) : '—'}  contrast ${r ? r.contrast : '—'}  conf ${(res.conf || 0).toFixed(2)}`,
    r?.digits?.length ? 'digits: ' + r.digits.map((g) => `${g.ch}(${g.conf.toFixed(2)})`).join(' ') : '',
    `${app.fps.toFixed(1)} frames/s · ${(res.ms || 0).toFixed(1)} ms/frame · source ${srcDims().join('×')} · zoom ${app.zoomTotal.toFixed(1)}× (lens ${app.hwZoom.toFixed(1)}×)`,
    res.pred ? `history: expect ${fmtInt(res.pred.value)} ±${fmtInt(res.pred.band)} kg${res.pred.external ? ' (from the tap rate)' : ''} · decision ${res.how}${res.strict != null && res.strict !== res.value ? ' (read ' + fmtInt(res.strict) + ')' : ''}` : `history: ${res.how || 'off'}`,
    res.candidates ? `most probable: ${res.candidates.map((x) => `${fmtInt(x.v)} ${probText(x.p)}`).join(' · ')}` : '',
    app.engine?.sess ? `noise σ ${Math.sqrt(app.engine.sess.R).toFixed(0)} kg · measurements ${app.engine.sess.meas.length}` : '',
  ];
  $('dbgText').textContent = lines.filter(Boolean).join('\n');
}

// ----------------------------------------------------------- live UI --

function setPill(text, kind) {
  const p = $('statusPill');
  if (p.textContent !== text) p.textContent = text;
  p.dataset.kind = kind;
}

function updateControls() {
  const b = $('btnStartStop');
  const eng = app.engine;
  b.classList.remove('stop');
  if (app.source === 'video') {
    b.disabled = false;
    b.textContent = app.vid?.running ? 'Stop analysis' : 'Analyse video';
    if (app.vid?.running) b.classList.add('stop');
  } else if (app.source) {
    b.disabled = false;
    b.textContent = eng?.sess ? 'End tap' : 'Start tap now';
    if (eng?.sess) b.classList.add('stop');
  } else {
    b.disabled = true;
    b.textContent = 'Start tap';
  }
  $('chkAuto').checked = !!(settings.autoStart && settings.autoStop);
}

function statusFromBand(rate) {
  const t = +settings.targetKgMin, tol = +settings.tolPct / 100;
  if (rate == null) return '';
  return rate > t * (1 + tol) ? 'fast' : rate < t * (1 - tol) ? 'slow' : 'ok';
}
const ARROW = { fast: '⬇', slow: '⬆', ok: '↔' };

function buildTiles() {
  const box = $('tiles');
  box.innerHTML = '';
  const ws = parseWindows(settings.windows);
  for (const w of [...ws, 'tap']) {
    const d = document.createElement('div');
    d.className = 'tile';
    d.dataset.w = w;
    const l = document.createElement('div'); l.className = 'tl'; l.textContent = w === 'tap' ? 'Tap avg' : `${w} s`;
    const v = document.createElement('div'); v.className = 'tv'; v.textContent = '—';
    const c = document.createElement('div'); c.className = 'tc'; c.textContent = ' ';
    const bar = document.createElement('div'); bar.className = 'bar'; bar.style.width = '0';
    d.append(l, v, c, bar);
    box.appendChild(d);
  }
  box.style.gridTemplateColumns = `repeat(${ws.length + 1}, 1fr)`;
}

function renderLive(withChart = false) {
  const eng = app.engine;
  const T = app.source === 'demo' && app.demo ? app.demo.t : app.source === 'video' ? eng?.lastT ?? 0 : performance.now() / 1000;
  const snap = eng ? eng.snapshot(T) : null;
  app.lastSnap = snap;
  renderPill(snap);
  renderMain(snap);
  renderTilesAndInfo(snap);
  updateAlarm(snap);
  updateControls();
  if (withChart) { app.lastChart = performance.now(); liveChart.render(liveSpec(snap)); }
}

function renderPill(snap) {
  if (!app.source) { setPill('Camera off', 'idle'); return; }
  const pre = app.source === 'demo' ? `DEMO ${app.demo?.speed}× · ` : app.source === 'video' ? 'VIDEO · ' : '';
  if (app.source === 'video' && app.vid?.running) {
    const s = snap?.session;
    setPill(`Analysing ${(100 * app.vid.progress).toFixed(0)}%${s ? ' · tap ' + fmtClock(s.segElapsed ?? 0) : ''}`, 'busy');
    return;
  }
  if (app.source === 'video') { setPill('Video loaded — frame the digits', 'busy'); return; }
  if (!snap) return;
  const S = snap.session;
  if (!S) {
    if (snap.signal === 'none') setPill(`${pre}Searching for the display…`, 'warn');
    else setPill(`${pre}${kg(snap.lastValue)} kg · waiting for tap`, 'reading');
    return;
  }
  if (snap.signal === 'none') setPill(`${pre}Display lost`, 'warn');
  else if (S.flowing) setPill(`${pre}TAPPING ${fmtClock(S.segElapsed ?? 0)}`, 'tapping');
  else setPill(`${pre}Recording · no flow`, 'reading');
}

function renderMain(snap) {
  const el = $('mainInd');
  const tgt = +settings.targetKgMin, tol = +settings.tolPct;
  let state = 'idle', arrow = '–', rate = '—', label = 'Start the camera to begin', sub = `Target ${tgt} kg/min ±${tol}%`, certain = '1';
  if (app.source && snap) {
    const S = snap.session;
    if (!S) {
      label = snap.signal === 'ok' ? (snap.scan?.startProgress > 0 ? 'Weight rising…' : 'Waiting for the weight to rise') : 'Aim at the scale display';
    } else {
      const m = S.main || {};
      if (m.rate != null) rate = fmtInt(m.rate);
      if (snap.signal === 'none') { state = 'nosignal'; arrow = '?'; label = 'Display lost — re-aim'; }
      else if (m.status === 'noflow') { state = 'noflow'; arrow = '‖'; label = S.segCount ? 'No flow' : 'Waiting for flow'; rate = '—'; }
      else if (m.status === 'measuring') { state = 'measuring'; arrow = '…'; label = 'Measuring…'; }
      else if (m.status === 'stopping') { state = 'measuring'; arrow = '↘'; label = 'Flow dropping…'; }
      else if (m.status === 'fast') { state = 'fast'; arrow = ARROW.fast; label = 'Too fast — slow down'; }
      else if (m.status === 'slow') { state = 'slow'; arrow = ARROW.slow; label = 'Too slow — speed up'; }
      else if (m.status === 'ok') { state = 'ok'; arrow = ARROW.ok; label = 'On target'; }
      if (['fast', 'slow', 'ok'].includes(state)) {
        certain = m.certain ? '1' : '0';
        sub = m.certain ? `±${fmtInt(m.ci)} (90%) · target ${tgt} ±${tol}%` : `±${fmtInt(m.ci)} (90%) · not yet certain`;
      } else if (state === 'measuring' && m.ci != null) sub = `±${fmtInt(m.ci)} (90%) · settling`;
    }
  }
  if (el.dataset.state !== state) el.dataset.state = state;
  el.dataset.certain = certain;
  $('miArrow').textContent = arrow;
  $('miRate').textContent = rate;
  $('miLabel').textContent = label;
  $('miSub').textContent = sub;
}

function renderTilesAndInfo(snap) {
  const S = snap?.session;
  const ws = parseWindows(settings.windows);
  const tiles = $('tiles').children;
  ws.forEach((w, i) => {
    const t = tiles[i];
    if (!t) return;
    const d = S?.tiles?.[w];
    const v = t.children[1], c = t.children[2], bar = t.children[3];
    if (!S || !d) { v.textContent = '—'; c.textContent = ' '; t.dataset.state = ''; t.dataset.stale = '0'; bar.style.width = '0'; return; }
    if (d.rate == null) {
      v.textContent = '—'; c.textContent = 'filling'; t.dataset.state = ''; bar.style.width = `${(100 * (d.progress || 0)).toFixed(0)}%`;
    } else {
      const st = statusFromBand(d.rate);
      v.textContent = `${fmtInt(d.rate)}${ARROW[st] ? '' : ''}`;
      c.textContent = `${ARROW[st]} ±${fmtInt(d.ci)}`;
      t.dataset.state = st;
      bar.style.width = '0';
    }
    t.dataset.stale = d.stale ? '1' : '0';
  });
  const tt = tiles[ws.length];
  if (tt) {
    const v = tt.children[1], c = tt.children[2];
    if (S?.tapAvg != null) {
      const st = statusFromBand(S.tapAvg);
      v.textContent = fmtInt(S.tapAvg); c.textContent = `${ARROW[st]} ±${fmtInt(S.tapCi)}`; tt.dataset.state = st;
      tt.dataset.stale = S.flowing ? '0' : '1';
    } else { v.textContent = '—'; c.textContent = ' '; tt.dataset.state = ''; }
  }
  $('infWeight').textContent = S ? kg(S.weight) : snap?.lastValue != null ? kg(snap.lastValue) : '—';
  $('infTapped').textContent = S?.tapped != null ? `+${kg(S.tapped)}` : '—';
  $('infTime').textContent = S?.segElapsed != null ? fmtClock(S.segElapsed) : S ? fmtClock(S.elapsed) : '—';
  $('infTouch').hidden = !S?.touch;
}

function updateAlarm(snap) {
  const m = snap?.session?.main;
  const now = performance.now();
  const red = m && (m.status === 'fast' || m.status === 'slow') && snap.signal !== 'none';
  if (!red) { app.alarm = { state: null, since: 0, lastBeep: 0 }; return; }
  if (app.alarm.state !== m.status) app.alarm = { state: m.status, since: now, lastBeep: 0 };
  const due = m.certain || now - app.alarm.since > 8000;
  if (settings.beep && due && now - app.alarm.lastBeep > settings.beepRepeatSec * 1000) {
    beeper.play(m.status);
    app.alarm.lastBeep = now;
  }
}

// ------------------------------------------------------------- charts --

const liveChart = new TimeChart($('liveChart'), {
  onDoubleTap: () => { app.liveSpan = app.liveSpan ? 0 : 180; renderLive(true); },
});

function bandItem() {
  const t = +settings.targetKgMin, tol = +settings.tolPct / 100;
  return { type: 'band', y0: t * (1 - tol), y1: t * (1 + tol), mid: t, color: COLORS.good, alpha: 0.16, label: `Target ±${settings.tolPct}%` };
}

function liveSpec(snap) {
  if (!snap) return { empty: 'Start the camera to begin' };
  const S = snap.session;
  if (!S) {
    const buf = snap.scan?.buf || [];
    if (!buf.length) return { empty: 'Waiting for readings…' };
    const T1 = snap.T;
    const xs = buf.map((m) => m.T - T1), ys = buf.map((m) => m.z);
    return {
      x0: -90, x1: 0,
      xfmt: (t) => (Math.abs(t) < 0.5 ? 'now' : `${Math.round(t)} s`),
      panels: [{ title: 'Weight, kg', minSpan: 300, items: [{ type: 'dots', xs, ys, color: COLORS.ink2, alpha: 0.75, r: 2 }] }],
      hover: (t) => {
        const i = nearestIndex(xs, t);
        return i < 0 ? null : { t: xs[i], title: `${Math.round(xs[i])} s`, rows: [{ v: `${kg(ys[i])} kg`, l: 'reading' }] };
      },
    };
  }
  const M = S.meas;
  const tEnd = S.elapsed;
  const t0 = app.liveSpan ? Math.max(0, tEnd - app.liveSpan) : 0;
  const ax = [], az = [], rx = [], rz = [], mx = [], mm = [], qq = [], qlo = [], qhi = [];
  for (const r of M) {
    if (r.t < t0) continue;
    if (r.flag === 'low' || r.flag === 'high') { rx.push(r.t); rz.push(r.z); } else { ax.push(r.t); az.push(r.z); }
    mx.push(r.t);
    mm.push(r.m ?? null);
    const q = r.q != null ? r.q * 60 : null, ci = r.qsd != null ? 1.645 * r.qsd * 60 : null;
    qq.push(q); qlo.push(q != null ? Math.max(0, q - ci) : null); qhi.push(q != null ? q + ci : null);
  }
  const tgt = +settings.targetKgMin;
  let qmax = tgt * 1.6;
  for (const v of qq) if (v != null && v * 1.1 > qmax) qmax = v * 1.1;
  const rateItems = [bandItem(), { type: 'area', xs: mx, lo: qlo, hi: qhi, color: COLORS.s1, alpha: 0.18, gap: 5 },
    { type: 'line', xs: mx, ys: qq, color: COLORS.s1, label: 'Kalman rate', endDot: true, gap: 5 }];
  if (app.source === 'demo' && app.demo) {
    const d = app.demo, T0 = S.T0;
    const tx = [], ty = [];
    for (let t = t0; t <= tEnd; t += 1) { tx.push(t); ty.push(d.sim.trueRate(t + T0)); }
    rateItems.push({ type: 'line', xs: tx, ys: ty, color: COLORS.s2, width: 1.5, label: 'True (sim)' });
  }
  return {
    x0: t0, x1: Math.max(tEnd, t0 + 30),
    panels: [
      {
        title: 'Weight, kg', frac: 1, minSpan: 300, note: app.liveSpan ? '3 min' : 'all',
        items: [
          { type: 'dots', xs: ax, ys: az, color: COLORS.ink2, alpha: 0.55, r: 1.7, label: 'Reading' },
          { type: 'cross', xs: rx, ys: rz, color: COLORS.serious, label: 'Rejected' },
          { type: 'line', xs: mx, ys: mm, color: COLORS.s1, label: 'Filtered', endDot: true, gap: 5 },
        ],
      },
      { title: 'Rate, kg/min', frac: 1, ymin: 0, ymax: Math.min(5000, qmax), items: rateItems },
    ],
    hover: (t) => {
      const i = nearestIndex(M.map((r) => r.t), t);
      if (i < 0) return null;
      const r = M[i];
      const rows = [{ v: `${kg(r.z)} kg`, l: r.flag === 'low' ? 'reading (touch, rejected)' : r.flag === 'high' ? 'reading (spike, rejected)' : 'reading' }];
      if (r.m != null) rows.push({ v: `${kg(r.m)} kg`, l: 'filtered', color: COLORS.s1 });
      if (r.q != null) rows.push({ v: `${fmtInt(r.q * 60)} ±${fmtInt(1.645 * r.qsd * 60)}`, l: 'kg/min', color: COLORS.s1 });
      return { t: r.t, title: fmtClock(r.t), rows };
    },
  };
}

function sessionSpec(s) {
  const a = s.analysis || analyseSession(s);
  const M = s.meas || [];
  const ax = [], az = [], rx = [], rz = [];
  for (const r of M) {
    if (r.f === 3 || r.f === 4) { rx.push(r.t); rz.push(r.z); } else { ax.push(r.t); az.push(r.z); }
  }
  const sm = a.smooth;
  const lo = sm.rate.map((v, i) => Math.max(0, v - sm.ci[i])), hi = sm.rate.map((v, i) => v + sm.ci[i]);
  const spans = a.segments.map((g) => [g.onset, g.end]);
  const tgt = s.config?.targetKgMin ?? +settings.targetKgMin, tol = s.config?.tolPct ?? +settings.tolPct;
  let qmax = tgt * 1.6;
  for (const v of sm.rate) if (v * 1.1 > qmax) qmax = v * 1.1;
  const x1 = M.length ? M[M.length - 1].t : 1;
  return {
    x0: 0, x1,
    panels: [
      {
        title: 'Weight, kg', minSpan: 300,
        items: [
          { type: 'vspan', spans, color: COLORS.s1, alpha: 0.08 },
          { type: 'dots', xs: ax, ys: az, color: COLORS.ink2, alpha: 0.6, r: 1.5, label: 'Reading' },
          { type: 'cross', xs: rx, ys: rz, color: COLORS.serious, label: 'Rejected' },
        ],
      },
      {
        title: 'Rate, kg/min', ymin: 0, ymax: Math.min(5000, qmax),
        items: [
          { type: 'vspan', spans, color: COLORS.s1, alpha: 0.08 },
          { type: 'band', y0: tgt * (1 - tol / 100), y1: tgt * (1 + tol / 100), mid: tgt, color: COLORS.good, alpha: 0.16, label: `Target ±${tol}%` },
          { type: 'area', xs: sm.t, lo, hi, color: COLORS.s1, alpha: 0.18, gap: 3 },
          { type: 'line', xs: sm.t, ys: sm.rate, color: COLORS.s1, label: 'Smoothed rate', gap: 3 },
        ],
      },
    ],
    hover: (t) => {
      const i = nearestIndex(M.map((r) => r.t), t);
      if (i < 0) return null;
      const r = M[i];
      const rows = [{ v: `${kg(r.z)} kg`, l: r.f === 3 ? 'reading (touch)' : r.f === 4 ? 'reading (spike)' : 'reading' }];
      const j = nearestIndex(sm.t, r.t);
      if (j >= 0 && Math.abs(sm.t[j] - r.t) < 2) rows.push({ v: `${fmtInt(sm.rate[j])} ±${fmtInt(sm.ci[j])}`, l: 'kg/min', color: COLORS.s1 });
      return { t: r.t, title: clockAt(s, r.t), rows };
    },
    xfmt: (t) => fmtClock(t),
  };
}

function clockAt(s, t) {
  const d = new Date(s.wall0 + t * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ------------------------------------------------------------ history --

const sesChart = new TimeChart($('sesChart'));
let openSessionObj = null;

function verdictText(v) { return v === 'fast' ? 'too fast' : v === 'slow' ? 'too slow' : v === 'ok' ? 'on target' : ''; }

// Taps saved before the analysis last improved are analysed again (and saved).
// Bring a saved recording up to date: re-run its raw frames if it was recorded by an
// older engine, and re-analyse it if the analysis has changed. Returns true if changed.
function freshen(s) {
  if (!s?.meas || s.status === 'active') return false;
  let changed = false;
  if (s.raw?.length && (s.engineVersion ?? 1) < ENGINE_VERSION) {
    try {
      const r = reprocessSession(s);
      if (r) {
        for (const k of ['meas', 'segments', 'events', 'touchCount', 'touchTime', 'noiseSigma', 'partialStart']) s[k] = r[k];
        s.analysis = null;
      }
    } catch (e) { console.warn('re-processing failed', e); }
    s.engineVersion = ENGINE_VERSION; // (also after a failure: keep the old results, don't retry)
    changed = true;
  }
  if (s.analysis?.version !== ANALYSIS_VERSION) { s.analysis = analyseSession(s); changed = true; }
  return changed;
}

async function renderHistory() {
  const box = $('historyList');
  let list = [];
  try { list = await store.all(); } catch (e) { console.warn(e); }
  for (const s of list) {
    if (!freshen(s)) continue;
    store.put(s).catch(() => {});
    await new Promise((r) => setTimeout(r, 0)); // keep the page responsive while catching up
  }
  box.replaceChildren();
  if (!list.length) {
    const p = document.createElement('div'); p.className = 'empty';
    p.textContent = 'No taps recorded yet. Taps are saved automatically when they finish.';
    box.appendChild(p);
    return;
  }
  for (const s of list) {
    const a = s.analysis?.totals || {};
    const card = document.createElement('div'); card.className = 'hcard';
    const h1 = document.createElement('div'); h1.className = 'h1';
    const d = new Date(s.wall0);
    h1.textContent = `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    for (const tag of [s.source === 'demo' && 'DEMO', s.source === 'video' && 'VIDEO', s.status === 'interrupted' && 'interrupted', s.status === 'active' && 'recording…']) {
      if (!tag) continue;
      const t = document.createElement('span'); t.className = 'tag'; t.textContent = tag; h1.appendChild(t);
    }
    const h2 = document.createElement('div'); h2.className = 'h2';
    const m = s.meta || {};
    const bits = [];
    if (m.pots) bits.push(`Pot ${m.pots}`);
    if (m.crucible) bits.push(`Crucible ${m.crucible}`);
    if (m.crew) bits.push(`Crew ${m.crew}`);
    bits.push(`${a.taps ?? 0} tap${a.taps === 1 ? '' : 's'}`);
    if (a.massKg) bits.push(`+${kg(a.massKg)} kg`);
    if (a.flowSec) bits.push(fmtClock(a.flowSec));
    h2.textContent = bits.join(' · ');
    const badge = document.createElement('div'); badge.className = 'badge'; badge.dataset.v = a.verdict || '';
    const bv = document.createElement('div'); bv.className = 'bv'; bv.textContent = a.avgKgMin != null ? fmtInt(a.avgKgMin) : '—';
    const bu = document.createElement('div'); bu.className = 'bu'; bu.textContent = a.avgKgMin != null ? `kg/min ${ARROW[a.verdict] || ''}` : '';
    badge.append(bv, bu);
    card.append(h1, badge, h2);
    card.addEventListener('click', () => openSession(s.id));
    box.appendChild(card);
  }
}

function statRow(tbl, k, v) {
  const tr = document.createElement('tr');
  const a = document.createElement('td'); a.textContent = k;
  const b = document.createElement('td'); b.textContent = v;
  tr.append(a, b); tbl.appendChild(tr);
}

async function openSession(id) {
  const s = await store.get(id);
  if (!s) return;
  if (freshen(s)) store.put(s).catch(() => {});
  else if (!s.analysis) s.analysis = analyseSession(s); // still being recorded
  openSessionObj = s;
  const d = new Date(s.wall0);
  $('sesTitle').textContent = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${s.source && s.source !== 'camera' ? ' · ' + s.source : ''}`;
  const body = $('sesBody');
  body.replaceChildren();
  const m = s.meta || {};
  const tot = s.analysis.totals;
  const tbl = document.createElement('table'); tbl.className = 'stats';
  statRow(tbl, 'Pot(s)', m.pots || '—');
  statRow(tbl, 'Crucible · crew · operator', [m.crucible || '—', m.crew || '—', m.operator || '—'].join(' · '));
  if (m.notes) statRow(tbl, 'Notes', m.notes);
  statRow(tbl, 'Metal tapped', tot.massKg ? `${kg(tot.massKg)} kg` : '—');
  statRow(tbl, 'Average rate (all taps)', tot.avgKgMin != null ? `${fmtInt(tot.avgKgMin)} kg/min · ${verdictText(tot.verdict)}` : '—');
  statRow(tbl, 'Target', `${s.config?.targetKgMin} kg/min ±${s.config?.tolPct}%`);
  statRow(tbl, 'Touch events', `${tot.touches ?? 0}`);
  statRow(tbl, 'Scale noise (σ)', tot.noiseSigma != null ? `${tot.noiseSigma} kg` : '—');
  if (tot.coverage != null) statRow(tbl, 'Readable time', `${Math.round(tot.coverage * 100)}%`);
  body.appendChild(tbl);
  s.analysis.segments.forEach((g, i) => {
    const c = document.createElement('div'); c.className = 'seg-card';
    const h = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = `Tap ${i + 1}: ${clockAt(s, g.onset)} – ${clockAt(s, g.end)} (${fmtClock(g.duration)})`;
    h.appendChild(strong);
    const t2 = document.createElement('table'); t2.className = 'stats';
    statRow(t2, 'Mass', `${kg(g.massKg)} kg  (${kg(g.levelBefore)} → ${kg(g.levelAfter)})`);
    const tr = document.createElement('tr');
    const k = document.createElement('td'); k.textContent = 'Average rate (Δmass ÷ time)';
    const v = document.createElement('td'); v.className = `verdict-${g.verdict}`;
    v.textContent = `${ARROW[g.verdict] || ''} ${fmtInt(g.avgKgMin)} ±${g.ciKgMin} kg/min`;
    tr.append(k, v); t2.appendChild(tr);
    if (g.peak60KgMin != null) statRow(t2, 'Highest 60 s rate', `${fmtInt(g.peak60KgMin)} kg/min`);
    if (g.pctFast != null) statRow(t2, 'Time fast / on target / slow', `${g.pctFast}% / ${g.pctOk}% / ${g.pctSlow}%`);
    statRow(t2, 'Touches', g.touches ? `${g.touches} (${g.touchSec} s)` : '0');
    if (g.openEnd) statRow(t2, 'Note', 'recording ended before the weight settled');
    if (g.partialStart) statRow(t2, 'Note', 'recording started mid-tap');
    c.append(h, t2);
    body.appendChild(c);
  });
  const dlg = $('dlgSession');
  if (!dlg.open) dlg.showModal();
  requestAnimationFrame(() => sesChart.render(sessionSpec(s)));
}

// --------------------------------------------------------- tap details --

let metaTarget = null; // 'current' or a stored session object

function openMeta(target) {
  metaTarget = target || 'current';
  const m = metaTarget === 'current' ? app.meta : metaTarget.meta || {};
  const f = $('formMeta');
  for (const k of ['pots', 'crucible', 'crew', 'operator', 'notes']) f.elements[k].value = m[k] || '';
  const dlg = $('dlgMeta');
  if (!dlg.open) dlg.showModal();
}

async function saveMeta() {
  const f = $('formMeta');
  const m = {};
  for (const k of ['pots', 'crucible', 'crew', 'operator', 'notes']) m[k] = f.elements[k].value.trim();
  settings.lastMeta = { crucible: m.crucible, crew: m.crew, operator: m.operator };
  saveSettings(settings);
  if (metaTarget === 'current') { app.meta = m; toast('Details saved for this tap'); }
  else if (metaTarget) {
    metaTarget.meta = m;
    await store.put(metaTarget);
    renderHistory();
    if ($('dlgSession').open && openSessionObj?.id === metaTarget.id) openSession(metaTarget.id);
    toast('Details saved');
  }
}

// ----------------------------------------------------------- settings --

function renderSettings() {
  const box = $('settingsForm');
  box.replaceChildren();
  for (const g of SCHEMA) {
    const sec = document.createElement('div'); sec.className = 'settings-group';
    const h = document.createElement('h3'); h.textContent = g.group; sec.appendChild(h);
    for (const it of g.items) {
      const lab = document.createElement('label');
      lab.className = 'field' + (it.type === 'checkbox' || it.type === 'number' ? ' inline' : '');
      const sp = document.createElement('span'); sp.textContent = it.label + (it.unit ? ` (${it.unit})` : '');
      let input;
      if (it.type === 'select') {
        input = document.createElement('select');
        for (const [val, txt] of it.options) {
          const o = document.createElement('option'); o.value = String(val); o.textContent = txt; input.appendChild(o);
        }
        input.value = String(settings[it.key]);
      } else {
        input = document.createElement('input');
        input.type = it.type === 'checkbox' ? 'checkbox' : it.type === 'number' ? 'number' : 'text';
        if (it.type === 'number') { input.inputMode = 'decimal'; if (it.min != null) input.min = it.min; if (it.max != null) input.max = it.max; if (it.step != null) input.step = it.step; }
        if (it.type === 'checkbox') input.checked = !!settings[it.key];
        else input.value = settings[it.key];
      }
      input.addEventListener('change', () => {
        let val = it.type === 'checkbox' ? input.checked : input.value;
        if (it.type === 'number' || (it.type === 'select' && typeof settings[it.key] === 'number')) {
          val = +val;
          if (!Number.isFinite(val)) { input.value = settings[it.key]; return; }
          if (it.min != null) val = Math.max(it.min, val);
          if (it.max != null) val = Math.min(it.max, val);
          input.value = val;
        }
        settings[it.key] = val;
        saveSettings(settings);
        applySettings(it.key);
      });
      lab.append(sp, input);
      sec.appendChild(lab);
      if (it.help) { const p = document.createElement('p'); p.className = 'help'; p.textContent = it.help; sec.appendChild(p); }
    }
    if (g.help) { const p = document.createElement('p'); p.className = 'help'; p.textContent = g.help; sec.appendChild(p); }
    box.appendChild(sec);
  }
  $('aboutText').textContent = `Tap Rate v${VERSION}. Reads the crane-scale display with the camera, filters it robustly and shows the tap rate against target. All data stays on this phone until you export it.`;
}

function applySettings(key) {
  if (app.engine) app.engine.setConfig(engineConfig(settings));
  if (key === 'windows' || key === 'targetKgMin' || key === 'tolPct') buildTiles();
  if ((key === 'resolution' || key === 'lowPower') && app.source === 'camera') restartCamera();
  if (key === 'lowPower' || key === 'all') syncPower();
  if (key === 'hwZoom') setZoom(app.zoomTotal);
  if (key === 'debug') $('debugPanel').hidden = !settings.debug;
  renderLive(true);
}

async function populateCameras() {
  const sel = $('selCamera');
  const cams = await Camera.listCameras();
  const cur = settings.deviceId;
  sel.replaceChildren();
  const def = document.createElement('option'); def.value = ''; def.textContent = 'Rear camera (default)'; sel.appendChild(def);
  for (const c of cams) {
    if (/front/i.test(c.label)) continue;
    const o = document.createElement('option'); o.value = c.deviceId; o.textContent = c.label || `Camera ${sel.length}`;
    sel.appendChild(o);
  }
  sel.value = cams.some((c) => c.deviceId === cur) ? cur : '';
}

// -------------------------------------------------------------- misc UI --

let toastTimer = null;
function toast(msg, ms = 3200) {
  const t = $('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function showView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === `view-${name}`);
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.view === name);
  if (name === 'history') renderHistory();
  if (name === 'review') renderReview();
  if (name === 'live') requestAnimationFrame(() => { applyView(); renderLive(true); });
}

function datestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function snapshotFrame() {
  const el = app.el;
  const [w, h] = srcDims();
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  c.getContext('2d').drawImage(el, 0, 0, w, h);
  const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
  if (!blob) { toast('Snapshot failed'); return; }
  const file = new File([blob], `scale-frame-${datestamp()}.png`, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: file.name }); return; } catch { /* fall through */ }
  }
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = file.name; a.click();
}

// --------------------------------------------------------------- wiring --

function wire() {
  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => showView(b.dataset.view));
  $('btnCamera').addEventListener('click', () => { beeper.unlock(); wake.request(); startCamera(); });
  $('btnPower').addEventListener('click', () => { stopSources(); toast('Camera stopped'); });
  $('btnStartStop').addEventListener('click', () => {
    beeper.unlock();
    if (app.source === 'video') { if (app.vid?.running) app.vid.cancel = true; else runVideo(); return; }
    const eng = app.engine;
    if (!eng) return;
    if (eng.sess) eng.endSession('manual');
    else { eng.startSession(eng.lastT, 'manual'); beeper.play('start'); }
    renderLive(true);
  });
  $('btnDetails').addEventListener('click', () => openMeta('current'));
  $('chkAuto').addEventListener('change', (e) => {
    settings.autoStart = settings.autoStop = e.target.checked;
    saveSettings(settings); applySettings('auto');
    toast(e.target.checked ? 'Automatic start/stop on' : 'Manual start/stop');
  });
  const mute = $('btnMute');
  const syncMute = () => { mute.textContent = settings.beep ? '🔔' : '🔕'; mute.classList.toggle('off', !settings.beep); };
  mute.addEventListener('click', () => { settings.beep = !settings.beep; saveSettings(settings); syncMute(); beeper.unlock(); renderSettings(); toast(settings.beep ? 'Alerts on' : 'Alerts muted'); });
  syncMute();
  $('btnLowPower').addEventListener('click', () => {
    settings.lowPower = !settings.lowPower;
    saveSettings(settings); renderSettings(); applySettings('lowPower');
    toast(settings.lowPower ? 'Low power mode: camera 1080p at 15 frames/s, 3 readings a second, picture dimmed while reading' : 'Low power mode off');
  });
  syncPower();
  const dbg = $('btnDebug');
  dbg.classList.toggle('on', !!settings.debug);
  $('debugPanel').hidden = !settings.debug;
  dbg.addEventListener('click', () => { settings.debug = !settings.debug; saveSettings(settings); dbg.classList.toggle('on', settings.debug); $('debugPanel').hidden = !settings.debug; });
  $('btnSnapshot').addEventListener('click', snapshotFrame);
  // tap details dialog
  $('formMeta').addEventListener('submit', (e) => {
    const how = e.submitter?.value;
    if (how === 'save') saveMeta();
  });
  // session dialog
  $('btnSesClose').addEventListener('click', () => $('dlgSession').close());
  $('btnSesEdit').addEventListener('click', () => openSessionObj && openMeta(openSessionObj));
  $('btnSesCsv').addEventListener('click', () => openSessionObj && shareOrDownload(`${sessionFileBase(openSessionObj)}.csv`, sessionCSV(openSessionObj)));
  $('btnSesRaw').addEventListener('click', () => openSessionObj && shareOrDownload(`${sessionFileBase(openSessionObj)}_frames.csv`, rawCSV(openSessionObj)));
  $('btnSesDelete').addEventListener('click', async () => {
    if (!openSessionObj || !confirm('Delete this recording? This cannot be undone.')) return;
    await store.delete(openSessionObj.id);
    $('dlgSession').close();
    renderHistory();
    toast('Deleted');
  });
  // history tools
  $('btnExportAll').addEventListener('click', async () => {
    const all = await store.all();
    if (!all.length) { toast('Nothing to export yet'); return; }
    for (const s of all) if (freshen(s)) store.put(s).catch(() => {});
    shareOrDownload(`tap-rate-summary-${datestamp()}.csv`, summaryCSV(all));
  });
  $('btnBackup').addEventListener('click', async () => {
    const all = await store.all();
    shareOrDownload(`tap-rate-backup-${datestamp()}.json`, JSON.stringify({ app: 'tap-rate', version: VERSION, sessions: all }), 'application/json');
  });
  $('fileImport').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = Array.isArray(data) ? data : data.sessions || [];
      let n = 0;
      for (const s of list) if (s && s.id && Array.isArray(s.meas)) { if (s.status === 'active') s.status = 'interrupted'; freshen(s); await store.put(s); n++; }
      toast(`Imported ${n} recording${n === 1 ? '' : 's'}`);
      renderHistory();
    } catch (err) { toast(`Import failed: ${err.message}`); }
  });
  // review
  $('reviewForm').addEventListener('submit', (e) => { e.preventDefault(); submitReviewValue(); });
  $('btnReviewUnreadable').addEventListener('click', () => review.cur && labelCrop(review.cur, 'unreadable'));
  $('btnReviewSkip').addEventListener('click', () => { if (review.cur) { review.skipped.add(review.cur.id); renderReview(); } });
  $('btnReviewDelete').addEventListener('click', async () => { if (review.cur) { await crops.delete(review.cur.id); renderReview(); } });
  $('btnCropExport').addEventListener('click', () => exportCrops().catch((e) => toast(`Export failed: ${e.message}`)));
  $('btnCropTest').addEventListener('click', () => testReaderOnCrops());
  $('btnCropClear').addEventListener('click', () => clearCrops());
  // settings tools
  $('selCamera').addEventListener('change', (e) => { settings.deviceId = e.target.value; saveSettings(settings); restartCamera(); });
  $('fileVideo').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) loadVideo(f); });
  $('btnDemo').addEventListener('click', () => startDemo(+$('selDemoSpeed').value || 5));
  $('btnResetSettings').addEventListener('click', () => {
    if (!confirm('Reset all settings to defaults?')) return;
    settings = resetSettings(); renderSettings(); buildTiles(); applySettings('all'); toast('Settings reset');
  });
  $('btnUpdate').addEventListener('click', async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      await reg?.update();
      if (self.caches) for (const k of await caches.keys()) await caches.delete(k);
    } catch { /* ignore */ }
    location.reload();
  });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') { saveActive(); return; }
    wake.refresh();
    if (app.source === 'camera' && !camera.active) {
      const P = powerProfile(settings);
      try { await camera.start({ deviceId: settings.deviceId, resolution: P.resolution, fps: P.camFps }); app.hwZoom = 1; setZoom(app.zoomTotal); } catch { toast('Tap “Start camera” to resume'); }
    }
  });
  window.addEventListener('pagehide', () => saveActive());
}

async function recoverInterrupted() {
  try {
    const all = await store.all();
    for (const s of all) {
      if (s.status !== 'active') continue;
      s.status = 'interrupted';
      s.analysis = analyseSession(s);
      if (s.analysis.totals.taps > 0) await store.put(s); else await store.delete(s.id);
    }
  } catch (e) { console.warn(e); }
}

async function init() {
  await store.open();
  await recoverInterrupted();
  crops.open().then(async () => { countCrops(await crops.list()); updateReviewBadge(); }).catch((e) => console.warn(e));
  wire();
  setupGestures();
  renderSettings();
  buildTiles();
  renderLive(true);
  requestAnimationFrame(loop);
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
  }
  const p = new URLSearchParams(location.search);
  if (p.has('demo')) startDemo(+p.get('demo') || 5, +p.get('seed') || 0);
  window.__tapRate = { app, settings: () => settings, store, crops }; // for debugging / automated tests
}

init();
