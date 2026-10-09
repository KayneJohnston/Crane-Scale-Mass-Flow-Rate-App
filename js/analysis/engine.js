// Mass-flow-rate engine: turns a stream of per-frame scale readings into
// tap sessions, a robust live tap-rate estimate and windowed rates.
//
//   frames (10/s, many duplicates, some misreads/nulls)
//     -> 0.5 s bins, median of the frame readings in each bin  ("measurements")
//     -> robust constant-rate Kalman filter (kalman.js) with physically motivated
//        outlier handling: the crucible cannot lose metal, so readings well below
//        the mass already established are "touch/support" events (crucible resting
//        on the cell) and are excluded; implausible upward jumps are excluded too.
//     -> Theil–Sen slopes over fixed windows (20/40/60/120 s) of accepted points
//     -> flow on/off detection, auto start/stop, target comparison.
//
// Times passed in are seconds on any monotonic clock (performance.now()/1000,
// video time, simulator time). Session records store seconds since session start.

import { robustSlope, hingeOnset, hingeStop, median, mean, lowerBound, secondDiffSigma } from './stats.js';
import { RateKF, rateVarToS } from './kalman.js';

export const ENGINE_DEFAULTS = {
  binSec: 0.5,
  minFramesPerBin: 1,
  stepKg: 50,
  targetKgMin: 600,
  tolPct: 10,
  windows: [20, 40, 60, 120],
  rateVar: 100,            // assumed drift of the true tap rate: kg/min per minute (1 sigma)
  qMaxKgMin: 3000,         // physically impossible above this
  R0: 40 * 40,             // initial measurement variance (kg^2) until estimated from data
  // automatic session start
  autoStart: true,
  startWindowSec: 30,
  startMinRateKgMin: 200,
  startMinRiseKg: 80,
  startT: 3,               // slope must be > 3 standard errors above zero
  startHold: 3,            // ... for 3 consecutive bins
  preBufferSec: 90,
  keepPreSec: 30,          // seconds of data kept before the detected onset
  // flow on / off inside a session
  flowWindowSec: 20,
  flowOnKgMin: 200,
  flowOffKgMin: 100,
  flowOffHoldSec: 8,
  // automatic session end. A crucible is filled from several pots: moving to the next
  // pot (~1 min) and building up the vacuum (~1 min) must not end the recording.
  autoStop: true,
  stallSec: 180,           // end when the weight has not risen ...
  stallRiseKg: 100,        // ... by this much over stallSec
  lostSec: 180,            // end after this long without any valid reading
  longLowSec: 60,          // "touch" lasting longer than this ends the session
  touchMinKg: 120,         // smallest drop reported as a touch event
  noSignalSec: 3,
  // robust Kalman gating
  gateLow: 3.5,
  gateHigh: 4.5,
  gatePred: 4,
  huberC: 2,
  reinitHighN: 8,
  reinitSlowN: 7,          // of the last 10 accepted points
  blindSec: 15,            // no reading at all for this long: the flow may have stopped or changed
  // display
  warmupSec: 12,
  maxRelSd: 0.15,
  hystPct: 1,
  stopGraceSec: 20,
};

export const FLAG_CODES = { pre: 0, ok: 1, slow: 2, low: 3, high: 4 };

// Bump when the live processing changes in a way that affects saved results: older
// recordings are then re-run from their raw camera frames (reprocessSession).
export const ENGINE_VERSION = 2;
export const STATUS_CODES = { noflow: 0, measuring: 1, ok: 2, fast: 3, slow: 4, stopping: 5 };

function makeId(wallMs) {
  const d = new Date(wallMs);
  const p = (n) => String(n).padStart(2, '0');
  return `T${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

const r1 = (x) => (x == null ? null : Math.round(x * 10) / 10);
const r4 = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);

export class TapEngine {
  constructor(cfg = {}, hooks = {}) {
    this.hooks = hooks;
    this.cfg = { ...ENGINE_DEFAULTS };
    this.setConfig(cfg);
    this.buf = [];          // measurements while scanning (no session)
    this.rawBuf = [];       // raw frames while scanning
    this.bin = null;
    this.sess = null;
    this.lastValue = null;
    this.lastValueT = -Infinity;
    this.lastT = 0;
    this.wallOffset = null;
    this.startCount = 0;
    this.replaying = false;
  }

  setConfig(cfg) {
    Object.assign(this.cfg, cfg);
    this.Sq = rateVarToS(this.cfg.rateVar);
    this.qMax = this.cfg.qMaxKgMin / 60;
    this.sigmaFloor = this.cfg.stepKg / Math.sqrt(12);
    if (this.sess) this.sess.kf.S = this.Sq;
  }

  // ------------------------------------------------------------- input --

  /**
   * One processed camera frame: value in kg or null if unreadable.
   * `how` (optional) records how the reader decided (ok, prior, jump-pending, ...).
   */
  pushFrame(T, wall, value, conf = 0, how = null) {
    this.lastT = Math.max(this.lastT, T);
    if (wall != null) this.wallOffset = wall - T * 1000;
    if (value != null) { this.lastValue = value; this.lastValueT = T; }
    const S = this.sess;
    const c = Math.round((conf || 0) * 100) / 100;
    const extra = how ? [how] : [];
    if (S) S.raw.push([+(T - S.T0).toFixed(3), value ?? null, c, ...extra]);
    else {
      this.rawBuf.push([T, value ?? null, c, ...extra]);
      const cut = T - this.cfg.preBufferSec;
      if (this.rawBuf.length && this.rawBuf[0][0] < cut) this.rawBuf = this.rawBuf.filter((r) => r[0] >= cut);
    }
    const k = Math.floor(T / this.cfg.binSec);
    if (this.bin && k !== this.bin.k) this.finalizeBin();
    if (!this.bin) this.bin = { k, vals: [], ts: [], frames: 0 };
    this.bin.frames++;
    if (value != null) { this.bin.vals.push(value); this.bin.ts.push(T); }
    this.tick(T);
  }

  /** Advance time without a frame (finalises bins, checks time-outs). */
  tick(T) {
    this.lastT = Math.max(this.lastT, T);
    if (this.bin && T >= (this.bin.k + 1) * this.cfg.binSec + 0.3) this.finalizeBin();
    const S = this.sess;
    if (S && this.cfg.autoStop && T - S.lastValidT >= this.cfg.lostSec) this.endSession('lost', S.lastValidT);
  }

  finalizeBin() {
    const b = this.bin;
    this.bin = null;
    if (!b || b.vals.length < this.cfg.minFramesPerBin) return;
    this.onMeasurement({ T: mean(b.ts), z: median(b.vals), n: b.vals.length });
  }

  onMeasurement(m) {
    if (this.sess) { this.sessMeasure(m); return; }
    this.buf.push(m);
    const cut = m.T - this.cfg.preBufferSec;
    while (this.buf.length && this.buf[0].T < cut) this.buf.shift();
    if (this.cfg.autoStart) this.checkStart(m.T);
  }

  // ---------------------------------------------------- session start --

  checkStart(T) {
    const c = this.cfg, W = c.startWindowSec;
    const pts = this.buf.filter((m) => m.T >= T - W);
    if (pts.length < (0.6 * W) / c.binSec) { this.startCount = 0; return; }
    const t = pts.map((p) => p.T), z = pts.map((p) => p.z);
    const f = robustSlope(t, z, 0, t.length, { sigmaFloor: this.sigmaFloor });
    if (!f) { this.startCount = 0; return; }
    const early = median(z.filter((_, i) => t[i] <= T - W + 4));
    const late = median(z.filter((_, i) => t[i] >= T - 4));
    const rate = f.slope * 60;
    const ok = rate >= c.startMinRateKgMin && rate <= c.qMaxKgMin && f.slope / f.se >= c.startT && late - early >= c.startMinRiseKg;
    this.startCount = ok ? this.startCount + 1 : 0;
    if (this.startCount >= c.startHold) this.startSession(T, 'auto');
  }

  startSession(T = this.lastT, reason = 'manual') {
    if (this.sess) return this.sess;
    const c = this.cfg;
    let onset = null;
    if (reason === 'auto' && this.buf.length >= 8) {
      onset = hingeOnset(this.buf.map((m) => m.T), this.buf.map((m) => m.z));
    }
    const firstT = this.buf.length ? this.buf[0].T : T;
    const T0 = Math.max(firstT, (onset ? onset.tau : T) - c.keepPreSec);
    const wall0 = this.wallOffset != null ? T0 * 1000 + this.wallOffset : Date.now();
    const S = (this.sess = {
      id: makeId(wall0), T0, wall0, startReason: reason,
      meas: [], events: [], segments: [],
      raw: this.rawBuf.filter((r) => r[0] >= T0).map((r) => [+(r[0] - T0).toFixed(3), ...r.slice(1)]),
      kf: new RateKF(this.Sq), kfActive: false, R: c.R0, rN: 0,
      floorM: 0, floorP: 0, floorT: 0,
      lowRun: 0, highRun: 0, slowHist: [],
      touch: null, touchCount: 0, touchTime: 0,
      acc: { t: [], z: [] },
      flowing: false, onCount: 0, offSince: null, segOnset: null, levelBefore: null, lastFlowEnd: null,
      tiles: {}, main: { status: 'noflow' }, mainState: 'ok',
      lastValidT: T, partialStart: false,
    });
    for (const m of this.buf) {
      if (m.T < T0) continue;
      const rec = { i: S.meas.length, t: m.T - T0, z: m.z, n: m.n, flag: 'pre' };
      S.meas.push(rec);
      S.acc.t.push(rec.t); S.acc.z.push(rec.z);
    }
    this.buf = []; this.rawBuf = []; this.startCount = 0;
    this.event('start', { reason }, Math.max(0, T - T0));
    if (onset) {
      S.partialStart = onset.tau <= firstT + 1;
      this.flowStart(onset.tau - T0, onset);
    }
    this.hooks.onSessionStart?.(S);
    return S;
  }

  event(type, info = {}, t = this.sess ? this.lastT - this.sess.T0 : 0) {
    const e = { t: r1(t), type, ...info };
    if (this.sess) this.sess.events.push(e);
    this.hooks.onEvent?.(e);
  }

  // ------------------------------------------------------- per measurement --

  sessMeasure(m) {
    const S = this.sess;
    const rec = { i: S.meas.length, t: m.T - S.T0, z: m.z, n: m.n, flag: 'pre' };
    S.meas.push(rec);
    S.lastValidT = m.T;
    if (S.kfActive) this.kfProcess(rec);
    else { S.acc.t.push(rec.t); S.acc.z.push(rec.z); }
    if (!this.sess) return; // ended (e.g. long low)
    if (++S.rN % 10 === 0) this.updateNoise(rec.t);
    this.evaluate(rec);
  }

  updateNoise(t) {
    const S = this.sess, A = S.acc;
    const i0 = lowerBound(A.t, t - 60);
    const sig = secondDiffSigma(A.t, A.z, i0, A.t.length);
    if (sig == null) return;
    const Rn = Math.min(300 * 300, Math.max(sig * sig, this.sigmaFloor ** 2));
    S.R = S.rN <= 10 ? Rn : 0.7 * S.R + 0.3 * Rn;
  }

  /**
   * Lower bound for a plausible reading. The crucible cannot lose metal, so a
   * reading well below the mass already established is a touch/support event.
   * The established mass is the median of the last 10 s of accepted readings
   * (robust, and unlike the filter it cannot overshoot when the flow stops),
   * advanced by half the expected rise since the middle of that window.
   */
  floorFor(rec) {
    const S = this.sess, c = this.cfg, A = S.acc, R = S.R;
    const i1 = lowerBound(A.t, rec.t), i0 = lowerBound(A.t, rec.t - 10);
    const n = i1 - i0;
    if (n >= 5) {
      const zz = A.z.slice(i0, i1), tt = A.t.slice(i0, i1);
      const lvl = median(zz) + 0.5 * S.kf.q * (rec.t - mean(tt));
      return lvl - c.gateLow * Math.sqrt((4.7 * R) / n + R);
    }
    // Few recent readings (display lost, long touch): the level of the last accepted
    // readings. Not the filter's estimate, which may have run on across the gap.
    const k0 = Math.max(0, i1 - 5);
    if (i1 > k0) return median(A.z.slice(k0, i1)) - c.gateLow * Math.sqrt((4.7 * R) / (i1 - k0) + R);
    return S.floorM - c.gateLow * Math.sqrt(S.floorP + R);
  }

  kfProcess(rec) {
    const S = this.sess, c = this.cfg, kf = S.kf;
    const floor = this.floorFor(rec);
    // After a spell with no readings at all (e.g. the crane moving to the next pot), the
    // flow may have stopped or changed meanwhile: the rate carried across the gap is
    // uncertain by about half its value, so the filter re-locks onto the new readings.
    const prev = S.meas[rec.i - 1];
    if (prev && rec.t - prev.t > c.blindSec) kf.Pqq += (kf.q / 2) ** 2;
    kf.predict(rec.t);
    const R = S.R;
    const sd = Math.sqrt(kf.Pmm + R);
    const nu = rec.z - kf.m;
    let flag;
    if (rec.z < floor) flag = 'low';                                   // impossible decrease: touch/support
    else if (nu > c.gateHigh * sd && nu > 2.5 * c.stepKg) flag = 'high'; // spike / misread
    else {
      const r = Math.abs(nu) / sd;
      const w = r > c.huberC ? c.huberC / r : 1;                      // Huber down-weighting
      kf.update(rec.z, R / w);
      if (kf.q < 0) kf.q = 0; else if (kf.q > this.qMax) kf.q = this.qMax;
      flag = nu < -c.gatePred * sd ? 'slow' : 'ok';
      if (w < 1) rec.w = Math.round(w * 1000) / 1000;
      S.floorM = kf.m; S.floorP = kf.Pmm; S.floorT = rec.t;
    }
    rec.flag = flag;
    rec.m = kf.m; rec.q = kf.q; rec.qsd = Math.sqrt(kf.Pqq);
    S.lowRun = flag === 'low' ? S.lowRun + 1 : 0;
    S.highRun = flag === 'high' ? S.highRun + 1 : 0;
    if (flag === 'ok' || flag === 'slow') {
      S.slowHist.push(flag === 'slow' ? 1 : 0);
      if (S.slowHist.length > 10) S.slowHist.shift();
      S.acc.t.push(rec.t); S.acc.z.push(rec.z);
    }
    // touch / support bookkeeping
    if (flag === 'low') {
      if (!S.touch) S.touch = { start: rec.t, depth: 0, reported: false };
      S.touch.depth = Math.max(S.touch.depth, S.floorM - rec.z);
      if (!S.touch.reported && S.lowRun >= 2 && S.touch.depth >= c.touchMinKg) { S.touch.reported = true; this.event('touch', {}, S.touch.start); }
    } else if (S.touch && flag !== 'high') {
      if (S.touch.reported) {
        const dur = rec.t - S.touch.start;
        S.touchCount++; S.touchTime += dur;
        this.event('touch-end', { dur: r1(dur), depth: Math.round(S.touch.depth) }, rec.t);
      }
      S.touch = null;
    }
    if (S.highRun >= c.reinitHighN) this.tryReinit('high', rec);
    else if (S.slowHist.length >= 10 && S.slowHist.reduce((a, b) => a + b, 0) >= c.reinitSlowN) this.tryReinit('slow', rec);
    if (!this.replaying && S.touch && rec.t - S.touch.start > c.longLowSec && c.autoStop) {
      this.endSession('low', S.T0 + S.floorT);
    }
  }

  tryReinit(kind, rec) {
    const S = this.sess, c = this.cfg, R = S.R;
    const pts = [];
    if (kind === 'high') {
      for (let i = rec.i; i >= 0 && S.meas[i].flag === 'high'; i--) pts.unshift(S.meas[i]);
    } else {
      for (let i = rec.i; i >= 0 && S.meas[i].t >= rec.t - 15; i--) {
        const f = S.meas[i].flag;
        if (f === 'ok' || f === 'slow') pts.unshift(S.meas[i]);
      }
    }
    if (pts.length < 6) return false;
    const t = pts.map((p) => p.t), z = pts.map((p) => p.z);
    const f = robustSlope(t, z, 0, t.length, { sigmaFloor: this.sigmaFloor });
    if (!f) return false;
    if (kind === 'high') {
      // reachable from the last reading the filter accepted (not from the filter itself,
      // which may be what went wrong)
      const A = S.acc, k = A.t.length - 1;
      const refT = k >= 0 ? A.t[k] : S.floorT, refZ = k >= 0 ? A.z[k] : S.floorM;
      const reach = this.qMax * Math.max(0, pts[0].t - refT) + 4 * Math.sqrt(R + S.floorP) + c.stepKg;
      if (pts[0].z - refZ > reach) return false;                  // physically impossible jump
      if (f.sigma > 3 * Math.sqrt(R) + c.stepKg) return false;     // readings not self-consistent
    }
    const m = f.intercept + f.slope * (rec.t - f.tm);
    const q = Math.min(this.qMax, Math.max(0, f.slope));
    S.kf.init(rec.t, m, q, Math.max((4 * R) / pts.length, 100), Math.max(f.se * f.se, 0.25));
    S.floorM = m; S.floorP = S.kf.Pmm; S.floorT = rec.t;
    if (kind === 'high') {
      for (const p of pts) { p.flag = 'ok'; S.acc.t.push(p.t); S.acc.z.push(p.z); }
    }
    S.highRun = 0; S.slowHist = [];
    rec.m = m; rec.q = q; rec.qsd = Math.sqrt(S.kf.Pqq);
    this.event('reinit', { kind }, rec.t);
    return true;
  }

  rebuildAccepted(tMax = Infinity) {
    const S = this.sess;
    S.acc = { t: [], z: [] };
    for (const r of S.meas) {
      if (r.t > tMax) break;
      if (r.flag === 'pre' || r.flag === 'ok' || r.flag === 'slow') { S.acc.t.push(r.t); S.acc.z.push(r.z); }
    }
  }

  windowSlope(t, w, tMin, minSpanFrac, minN) {
    const A = this.sess.acc;
    const i0 = lowerBound(A.t, Math.max(t - w, tMin)), i1 = A.t.length;
    if (i1 - i0 < minN) return null;
    if (A.t[i1 - 1] - A.t[i0] < minSpanFrac * w) return null;
    return robustSlope(A.t, A.z, i0, i1, { sigmaFloor: this.sigmaFloor });
  }

  levelAt(t) {
    const M = this.sess.meas;
    let lo = 0, hi = M.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (M[mid].t <= t) lo = mid + 1; else hi = mid; }
    for (let i = lo - 1, n = 0; i >= 0 && n < 40; i--, n++) if (M[i].L != null) return M[i].L;
    return null;
  }

  evaluate(rec) {
    const S = this.sess, c = this.cfg, t = rec.t;
    const f20 = this.windowSlope(t, c.flowWindowSec, -Infinity, 0.5, 16);
    rec.f20 = f20 ? Math.round(f20.slope * 60) : null;
    if (!S.flowing) {
      const on = f20 && f20.slope * 60 >= c.flowOnKgMin && f20.slope * 60 <= c.qMaxKgMin && f20.slope / f20.se >= c.startT;
      S.onCount = on ? S.onCount + 1 : 0;
      if (S.onCount >= c.startHold) this.flowStart(null, null);
    } else if (f20) {
      // Both the 20 s slope and the filter must say the flow has stopped: in a slow tap
      // the display can sit on one value for 10-15 s while the metal keeps flowing.
      const filterLow = !S.kfActive || S.kf.q * 60 < c.flowOffKgMin;
      if (f20.slope * 60 < c.flowOffKgMin && filterLow) { if (S.offSince == null) S.offSince = t; }
      else S.offSince = null;
      if (S.offSince != null && t - S.offSince >= c.flowOffHoldSec) this.flowStop(t);
    }
    // fixed-window rates inside the current flow segment
    for (const w of c.windows) {
      if (!S.flowing) { if (S.tiles[w]) S.tiles[w].stale = true; continue; }
      const f = this.windowSlope(t, w, S.segOnset, 0.8, Math.max(6, (0.4 * w) / c.binSec));
      rec['r' + w] = f ? Math.round(f.slope * 60) : null;
      S.tiles[w] = f
        ? { rate: f.slope * 60, ci: 1.645 * f.se * 60, n: f.n, span: f.span }
        : { rate: null, progress: Math.min(1, (t - S.segOnset) / (0.8 * w)) };
    }
    // robust current level (median of the last 10 s of accepted readings)
    const A = S.acc, i0 = lowerBound(A.t, t - 10);
    rec.L = A.t.length - i0 >= 3 ? median(A.z.slice(i0)) : null;
    // auto end: weight has not risen by stallRiseKg over stallSec
    if (c.autoStop && !S.flowing && rec.L != null && t >= c.stallSec + 5) {
      const past = this.levelAt(t - c.stallSec);
      if (past != null && rec.L - past < c.stallRiseKg) { this.endSession('stall', S.T0 + t); return; }
    }
    this.updateMain(rec);
  }

  flowStart(onset, h) {
    const S = this.sess, c = this.cfg;
    let a = h?.a, b = h?.b, seB = h?.seB;
    if (a == null) {
      const now = S.meas[S.meas.length - 1].t;
      const i0 = lowerBound(S.acc.t, now - 90);
      const tt = S.acc.t.slice(i0), zz = S.acc.z.slice(i0);
      const hh = hingeOnset(tt, zz);
      if (hh) ({ tau: onset, a, b, seB } = hh);
      else {
        const f = robustSlope(tt, zz, 0, tt.length, { sigmaFloor: this.sigmaFloor });
        if (!f) return;
        onset = tt[0]; a = f.intercept + f.slope * (tt[0] - f.tm); b = f.slope; seB = f.se;
      }
    }
    b = Math.min(this.qMax, Math.max(0, b));
    if (S.lastFlowEnd != null && onset < S.lastFlowEnd) {
      // flow resumed where the last flow was taken to end: start from the level at
      // that moment, not the level at the fit's earlier change point
      a += b * (S.lastFlowEnd - onset);
      onset = S.lastFlowEnd;
    }
    S.flowing = true; S.offSince = null; S.onCount = 0; S.lowSince = null;
    S.segOnset = onset; S.levelBefore = a;
    S.segments.push({ onset: r1(onset), levelBefore: Math.round(a), end: null });
    S.kf.init(onset, a, b, S.R, Math.max(seB ?? 1, 1) ** 2);
    S.kfActive = true;
    S.floorM = a; S.floorP = S.R; S.floorT = onset;
    S.lowRun = 0; S.highRun = 0; S.slowHist = []; S.touch = null;
    S.mainState = 'ok';
    // replay the measurements since the onset through the filter
    this.rebuildAccepted(onset);
    this.replaying = true;
    for (const rec of S.meas) if (rec.t > onset) this.kfProcess(rec);
    this.replaying = false;
    this.event('flow-start', { onset: r1(onset), rate: Math.round(b * 60) }, onset);
  }

  flowStop(t) {
    const S = this.sess;
    const i0 = lowerBound(S.acc.t, Math.max(S.segOnset, t - 90));
    const h = hingeStop(S.acc.t.slice(i0), S.acc.z.slice(i0));
    let end = h ? h.tau : (S.offSince ?? t);
    end = Math.min(t, Math.max(end, S.segOnset));
    const seg = S.segments[S.segments.length - 1];
    if (seg && seg.end == null) seg.end = r1(end);
    S.flowing = false; S.offSince = null; S.lastFlowEnd = end;
    S.main = { status: 'noflow' };
    this.event('flow-stop', { end: r1(end) }, end);
  }

  updateMain(rec) {
    const S = this.sess, c = this.cfg;
    if (!S.flowing || !S.kfActive) { S.main = { status: 'noflow' }; rec.st = 0; return; }
    const q = S.kf.q * 60, sd = Math.sqrt(S.kf.Pqq) * 60, ci = 1.645 * sd;
    const tgt = c.targetKgMin, hi = tgt * (1 + c.tolPct / 100), lo = tgt * (1 - c.tolPct / 100), h = (tgt * c.hystPct) / 100;
    // A rate far below the band (under half the low limit), or below the band and
    // fallen > 15% within 10 s, may be the tap ending: show "flow dropping" (no alarm)
    // for stopGraceSec. If the flow carries on below the band, it is a slow tap: then
    // "too slow" - unless the rate is near zero (a quarter of the low limit), which is
    // the tap ending. The timer only restarts once the rate is back in the band, so a
    // slow tap whose rate wobbles still gets its alarm.
    let q10 = q;
    for (let i = S.meas.length - 1; i >= 0 && S.meas[i].t >= rec.t - 10; i--) if (S.meas[i].q != null) q10 = Math.max(q10, S.meas[i].q * 60);
    const declining = q < lo && q < 0.85 * q10;
    if (q < 0.5 * lo || declining) { if (S.lowSince == null) S.lowSince = rec.t; }
    else if (q >= lo) S.lowSince = null;
    let status;
    if (rec.t - S.segOnset < c.warmupSec || sd > c.maxRelSd * tgt) status = 'measuring';
    else if (S.lowSince != null && (rec.t - S.lowSince < c.stopGraceSec || q < 0.25 * lo)) status = 'stopping';
    else {
      let st = S.mainState;
      if (st === 'ok') { if (q > hi + h) st = 'fast'; else if (q < lo - h) st = 'slow'; }
      else if (st === 'fast') { if (q < hi - h) st = q < lo - h ? 'slow' : 'ok'; }
      else if (st === 'slow') { if (q > lo + h) st = q > hi + h ? 'fast' : 'ok'; }
      S.mainState = st;
      status = st;
    }
    let certain = false;
    if (status === 'fast') certain = q - ci > hi;
    else if (status === 'slow') certain = q + ci < lo;
    else if (status === 'ok') certain = q - ci >= lo && q + ci <= hi;
    S.main = { status, rate: q, ci, sd, certain };
    rec.st = STATUS_CODES[status];
  }

  // ------------------------------------------------------------ control --

  /** Manual stop (or automatic): finalise and hand the session to hooks.onSessionEnd. */
  endSession(reason = 'manual', endT = this.lastT) {
    const S = this.sess;
    if (!S) return null;
    if (S.flowing) this.flowStop(Math.max(S.segOnset, endT - S.T0));
    S.endT = endT - S.T0;
    this.event('end', { reason }, S.endT);
    S.endReason = reason;
    const out = this.exportSession();
    out.status = 'complete';
    this.sess = null;
    this.buf = []; this.rawBuf = []; this.startCount = 0;
    this.hooks.onSessionEnd?.(out);
    return out;
  }

  /** Plain, serialisable copy of the current session (for saving). */
  exportSession() {
    const S = this.sess;
    if (!S) return null;
    const c = this.cfg;
    return {
      id: S.id,
      version: 1,
      engineVersion: ENGINE_VERSION,
      startedAt: new Date(S.wall0).toISOString(),
      wall0: S.wall0,
      endedAt: S.endT != null ? new Date(S.wall0 + S.endT * 1000).toISOString() : null,
      duration: r1(S.endT ?? this.lastT - S.T0),
      startReason: S.startReason,
      endReason: S.endReason ?? null,
      partialStart: S.partialStart,
      status: 'active',
      config: {
        targetKgMin: c.targetKgMin, tolPct: c.tolPct, windows: c.windows, rateVar: c.rateVar,
        stepKg: c.stepKg, binSec: c.binSec,
      },
      noiseSigma: r1(Math.sqrt(S.R)),
      segments: S.segments.map((s) => ({ ...s })),
      events: S.events.slice(),
      touchCount: S.touchCount,
      touchTime: r1(S.touchTime),
      meas: S.meas.map((r) => {
        const o = { t: Math.round(r.t * 1000) / 1000, z: r.z, n: r.n, f: FLAG_CODES[r.flag] };
        if (r.m != null) { o.m = r1(r.m); o.q = r4(r.q); o.qs = r4(r.qsd); }
        if (r.w != null) o.w = r.w;
        if (r.f20 != null) o.f20 = r.f20;
        for (const w of c.windows) if (r['r' + w] != null) o['r' + w] = r['r' + w];
        if (r.L != null) o.L = r.L;
        if (r.st != null) o.st = r.st;
        return o;
      }),
      raw: S.raw,
      meta: {},
    };
  }

  // ------------------------------------------------------------- output --

  snapshot(T = this.lastT) {
    const c = this.cfg, S = this.sess;
    const since = T - this.lastValueT;
    const snap = {
      state: S ? 'recording' : 'scanning',
      signal: since < 1.5 ? 'ok' : since < c.noSignalSec ? 'weak' : 'none',
      lastValue: this.lastValue,
      T,
    };
    if (!S) {
      snap.scan = { buf: this.buf, startProgress: Math.min(1, this.startCount / c.startHold) };
      return snap;
    }
    const now = T - S.T0;
    const seg = S.segments[S.segments.length - 1] || null;
    let weight = this.lastValue, tapped = null, tapAvg = null, tapCi = null;
    if (S.kfActive) weight = S.kf.m;
    if (seg && S.kfActive) {
      const end = seg.end ?? now;
      const lvl = seg.end == null ? S.kf.m : (this.levelAt(now) ?? S.kf.m);
      tapped = lvl - seg.levelBefore;
      const dt = end - seg.onset;
      if (dt >= 10) {
        tapAvg = (tapped / dt) * 60;
        tapCi = (1.645 * Math.sqrt(S.kf.Pmm + 2 * S.R / 10) / dt) * 60;
      }
    }
    snap.session = {
      id: S.id, T0: S.T0, wall0: S.wall0, elapsed: now,
      flowing: S.flowing, segCount: S.segments.length,
      segElapsed: seg ? (seg.end ?? now) - seg.onset : null,
      weight, tapped, tapAvg, tapCi,
      main: S.main,
      tiles: S.tiles,
      touch: !!(S.touch && S.touch.reported),
      touchCount: S.touchCount,
      sigma: Math.sqrt(S.R),
      events: S.events,
      meas: S.meas,
      partialStart: S.partialStart,
    };
    return snap;
  }
}

/**
 * Re-run a saved recording's raw camera frames through the current engine, so its
 * readings are judged by the current rules (e.g. after a fix). Same start, end and
 * settings as the recording; returns the new session, or null without raw frames.
 */
export function reprocessSession(sess) {
  const raw = sess?.raw;
  if (!raw?.length) return null;
  const eng = new TapEngine({ ...(sess.config || {}), autoStart: false, autoStop: false });
  const push = (r) => eng.pushFrame(r[0], sess.wall0 + r[0] * 1000, r[1], r[2], r[3]);
  push(raw[0]);
  eng.startSession(0, sess.startReason === 'auto' ? 'auto' : 'manual');
  for (let i = 1; i < raw.length; i++) push(raw[i]);
  const out = eng.endSession(sess.endReason || 'manual', sess.duration ?? raw[raw.length - 1][0]);
  if (out) Object.assign(out, { id: sess.id, startReason: sess.startReason });
  return out;
}
