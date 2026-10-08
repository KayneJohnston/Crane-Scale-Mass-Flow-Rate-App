// Two-stage frame reader: coarse localisation in a downscaled view, then a
// tight, rescaled crop is read digit by digit. With a time stamp, each reading is
// also checked against the recent history of readings (tracker.js).
//
// The pixel source is abstracted as a `sample(x, y, w, h, dw, dh)` function
// returning RGBA pixels of the source rectangle scaled to dw x dh. In the
// browser this is canvas.drawImage(); in Node it is sampler.js.

import { locateDisplay, readDigits, validateReading, expectedDigits, decodeLattice } from './sevenseg.js';
import { DisplayTracker, TRACK_DEFAULTS, bestInBand } from './tracker.js';

export const PIPE_DEFAULTS = {
  searchW: 400,        // width of the downscaled search image
  digitTargetH: 48,    // digit height (px) the read crop is rescaled to
  maxReadW: 1000,
  colorMode: 'auto',   // 'auto' | 'red' | 'hot' (over-exposed) | 'bright'
  strictness: 1,
  minKg: 1000, maxKg: 40000, stepKg: 50, multiplier: 1, expectDigits: undefined,
  minConf: 0.15,
  maxCandidates: 2,
  temporal: true,      // use the recent readings as a prior (needs the frame time t)
  decodeMinMargin: 0.8,    // constrained decoding: the best valid value must beat the next by this,
  decodeMaxDigitExcess: 0.5, // ... only settle digits that were ambiguous (never overrule a clear one)
  decodeMaxDigitCost: 2.2, // ... and no digit may fit worse than this
  keepDebug: false,
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * Read one frame.
 * `track` persists between frames (display position, reading history);
 * `t` is the frame time in seconds (enables the temporal consistency checks).
 * Result: {ok, value, how, reason, located, quads, ...}; `how` is one of
 *   ok | prior | locked | jump-accepted   (value given)
 *   locking | jump-pending | unread                   (no value)
 */
export function readFrame(sample, srcW, srcH, view, cfg = {}, track = {}, t = null) {
  const c = { ...TRACK_DEFAULTS, ...PIPE_DEFAULTS, ...cfg };
  // auto: red digits, then over-exposed ("hot": white cores in red glow), then any
  // bright digits - starting with whichever mode worked last
  let modes = c.colorMode === 'auto' ? ['red', 'hot', 'bright'] : [c.colorMode];
  if (track.lastMode && modes.includes(track.lastMode)) modes = [track.lastMode, ...modes.filter((m) => m !== track.lastMode)];
  const tracker = c.temporal && t != null ? (track.tracker ||= new DisplayTracker()) : null;
  const pred = tracker ? tracker.predict(t, c) : null;
  // the digit count the display should show, from the recent readings
  if (pred && c.expectDigits == null) {
    const m = c.multiplier || 1;
    const a = String(Math.round(Math.max(c.minKg, pred.value - pred.band) / m)).length;
    const b = String(Math.round(Math.min(c.maxKg, pred.value + pred.band) / m)).length;
    if (a === b) c.expectDigits = a;
  }
  const attempts = [];
  for (const mode of modes) {
    const r = attempt(sample, srcW, srcH, view, c, track, mode);
    attempts.push(r);
    if (r.ok && (!pred || Math.abs(r.value - pred.value) <= pred.band)) break;
    const nb = pred ? bestInBand(r.lattice, pred, c) : null;
    if (nb && nb.inBand && pred.band <= c.rescueMaxBandSteps * c.stepKg && nb.excess <= c.rescueMaxDelta && nb.maxDigitCost <= c.rescueMaxDigitCost && nb.margin >= c.rescueMinMargin) break;
  }
  const base = attempts.find((r) => r.ok) || attempts.find((r) => r.located) || attempts[0];
  let res = base;
  if (tracker) {
    const d = tracker.decide(t, attempts, c, pred);
    const src = d.from || base;
    res = { ...src, ok: d.value != null, value: d.value, how: d.how, pred: d.pred, strict: base.ok ? base.value : null };
    if (d.how === 'prior') {
      res.located = src.latLocated || src.located;
      res.quads = src.latQuads || src.quads;
      res.text = String(Math.round(d.value / (c.multiplier || 1)));
      res.conf = Math.min(src.conf || 0.5, 0.5);
    }
    if (!res.ok) res.reason = d.how === 'unread' ? base.reason : d.how;
    if (res.ok && res.located) {
      track.prev = { cx: res.located.x + res.located.w / 2, cy: res.located.y + res.located.h / 2, h: res.located.h };
      track.misses = 0;
    }
  } else if (base.ok) res.how = 'ok';
  if (res.ok && res.mode) track.lastMode = res.mode;
  if (!base.located) track.misses = (track.misses || 0) + 1;
  if (track.misses > 15) track.prev = null; // forget the old position after a while
  return res;
}

function attempt(sample, srcW, srcH, view, c, track, mode) {
  const ss = Math.min(1, c.searchW / view.w);
  const sw = Math.max(16, Math.round(view.w * ss)), sh = Math.max(16, Math.round(view.h * ss));
  const fx = sw / view.w, fy = sh / view.h;
  const img = sample(view.x, view.y, view.w, view.h, sw, sh);
  let prev = null;
  if (track.prev) prev = { cx: (track.prev.cx - view.x) * fx, cy: (track.prev.cy - view.y) * fy, h: track.prev.h * fy };
  const loc = locateDisplay(img, sw, sh, { colorMode: mode, strictness: c.strictness, prev, maxCandidates: c.maxCandidates });
  const out = { ok: false, reason: loc.contrast < 30 ? 'no-display' : 'not-found', located: null, mode, value: null, conf: 0, lattice: null };
  if (c.keepDebug) out.debug = { search: { img, w: sw, h: sh } };
  for (const cand of loc.candidates) {
    const bx = view.x + cand.x / fx, by = view.y + cand.y / fy, bw = cand.w / fx, bh = cand.h / fy;
    // a digit-cell of margin on both sides: a shorter reading than the range allows is
    // only trusted if the cell where its missing leading digit would be is visibly empty
    const mx = 1.0 * bh + 2 / fx, my = 0.35 * bh + 2 / fy;
    const x0 = Math.max(0, bx - mx), y0 = Math.max(0, by - my);
    const x1 = Math.min(srcW, bx + bw + mx), y1 = Math.min(srcH, by + bh + my);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 4 || ch < 4) continue;
    // over-exposed digits are thin cores: read them at a higher resolution
    const target = mode === 'hot' ? c.digitTargetH * 1.6 : c.digitTargetH;
    let rs = clamp(target / Math.max(1, bh), 0.2, 4);
    if (cw * rs > c.maxReadW) rs = c.maxReadW / cw;
    const rw = Math.max(8, Math.round(cw * rs)), rh = Math.max(8, Math.round(ch * rs));
    const img2 = sample(x0, y0, cw, ch, rw, rh);
    const expect = c.expectDigits ?? expectedDigits(c.minKg, c.maxKg, c.multiplier || 1);
    // "bright" mode also sees glare and unlit segments, so demand clearer digits there
    const r = readDigits(img2, rw, rh, {
      colorMode: mode, strictness: c.strictness, keepMask: c.keepDebug, expectDigits: expect,
      maxDigits: String(Math.round(c.maxKg / (c.multiplier || 1))).length,
      ...(mode === 'bright' ? { minMargin: 0.8, maxCost: 1.3 } : {}),
    });
    const sx = cw / rw, sy = ch / rh;
    const map = (q) => (q ? q.map(([x, y]) => [x0 + x * sx, y0 + y * sy]) : null);
    const located = { x: bx, y: by, w: bw, h: bh, edge: cand.touchesEdge };
    if (!out.located) {
      out.located = located;
      out.reason = r.ok ? out.reason : r.reason;
      out.text = r.text;
      out.digitHpx = r.digitH * sy;
      if (c.keepDebug) out.debug.read = { img: img2, w: rw, h: rh, res: r };
    }
    // digit costs for the temporal prior (bright mode is too glare-prone to be rescued)
    if (r.lattice && !out.lattice && mode !== 'bright') {
      out.lattice = r.lattice;
      out.latLocated = located;
      out.latQuads = r.digits.map((d) => map(d.quad));
    }
    let val = r.ok ? validateReading(r.text, r.conf, c) : { ok: false, why: r.reason };
    if (!val.ok && r.lattice && mode !== 'bright') {
      // some digit was ambiguous on its own: take the most likely valid value if it
      // clearly beats every other valid value. A digit that clearly shows something
      // impossible (a last digit that looks like an 8 on a 50 kg display) means the
      // picture cannot be trusted, so that is never "corrected"
      const dec = decodeLattice(r.lattice, c);
      if (dec && dec.margin >= c.decodeMinMargin && dec.maxDigitExcess <= c.decodeMaxDigitExcess && dec.maxDigitCost <= c.decodeMaxDigitCost) {
        val = { ok: true, value: dec.value, decoded: true };
        r.text = String(Math.round(dec.value / (c.multiplier || 1)));
        r.conf = Math.min(1, dec.margin / 3);
      }
    }
    if (!val.ok) {
      if (out.located === located) {
        if (r.ok) { out.reason = 'invalid-' + val.why; out.text = r.text; }
      }
      continue;
    }
    track.prev = { cx: bx + bw / 2, cy: by + bh / 2, h: bh };
    track.misses = 0;
    const res = {
      ok: true, value: val.value, text: r.text, conf: r.conf, mode, located, decoded: !!val.decoded,
      quads: r.digits.map((d) => map(d.quad)), bandQuad: map(r.bandQuad), digitHpx: r.digitH * sy,
      rotDeg: r.rotDeg, shear: r.shear, reason: '',
      lattice: mode !== 'bright' ? r.lattice : null, latLocated: located, latQuads: r.digits.map((d) => map(d.quad)),
    };
    if (c.keepDebug) res.debug = { ...(out.debug || {}), read: { img: img2, w: rw, h: rh, res: r } };
    return res;
  }
  return out;
}
