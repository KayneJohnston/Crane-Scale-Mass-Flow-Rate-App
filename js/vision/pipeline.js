// Two-stage frame reader: coarse localisation in a downscaled view, then a
// tight, rescaled crop is read digit by digit.
//
// The pixel source is abstracted as a `sample(x, y, w, h, dw, dh)` function
// returning RGBA pixels of the source rectangle scaled to dw x dh. In the
// browser this is canvas.drawImage(); in Node it is sampler.js.

import { locateDisplay, readDigits, validateReading } from './sevenseg.js';

export const PIPE_DEFAULTS = {
  searchW: 400,        // width of the downscaled search image
  digitTargetH: 48,    // digit height (px) the read crop is rescaled to
  maxReadW: 1000,
  colorMode: 'auto',   // 'auto' | 'red' | 'bright'
  strictness: 1,
  minKg: 10000, maxKg: 30000, stepKg: 50, multiplier: 1, expectDigits: undefined,
  minConf: 0.15,
  maxCandidates: 2,
  keepDebug: false,
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

export function readFrame(sample, srcW, srcH, view, cfg = {}, track = {}) {
  const c = { ...PIPE_DEFAULTS, ...cfg };
  const modes = c.colorMode === 'auto' ? ['red', 'bright'] : [c.colorMode];
  let first = null;
  for (const mode of modes) {
    const r = attempt(sample, srcW, srcH, view, c, track, mode);
    if (r.ok) return r;
    if (!first || (!first.located && r.located)) first = r;
  }
  if (!first.located) track.misses = (track.misses || 0) + 1;
  if (track.misses > 15) track.prev = null; // forget the old position after a while
  return first;
}

function attempt(sample, srcW, srcH, view, c, track, mode) {
  const ss = Math.min(1, c.searchW / view.w);
  const sw = Math.max(16, Math.round(view.w * ss)), sh = Math.max(16, Math.round(view.h * ss));
  const fx = sw / view.w, fy = sh / view.h;
  const img = sample(view.x, view.y, view.w, view.h, sw, sh);
  let prev = null;
  if (track.prev) prev = { cx: (track.prev.cx - view.x) * fx, cy: (track.prev.cy - view.y) * fy, h: track.prev.h * fy };
  const loc = locateDisplay(img, sw, sh, { colorMode: mode, strictness: c.strictness, prev, maxCandidates: c.maxCandidates });
  const out = { ok: false, reason: loc.contrast < 30 ? 'no-display' : 'not-found', located: null, mode, value: null, conf: 0 };
  if (c.keepDebug) out.debug = { search: { img, w: sw, h: sh } };
  for (const cand of loc.candidates) {
    const bx = view.x + cand.x / fx, by = view.y + cand.y / fy, bw = cand.w / fx, bh = cand.h / fy;
    const mx = 0.45 * bh + 2 / fx, my = 0.35 * bh + 2 / fy;
    const x0 = Math.max(0, bx - mx), y0 = Math.max(0, by - my);
    const x1 = Math.min(srcW, bx + bw + mx), y1 = Math.min(srcH, by + bh + my);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 4 || ch < 4) continue;
    let rs = clamp(c.digitTargetH / Math.max(1, bh), 0.2, 4);
    if (cw * rs > c.maxReadW) rs = c.maxReadW / cw;
    const rw = Math.max(8, Math.round(cw * rs)), rh = Math.max(8, Math.round(ch * rs));
    const img2 = sample(x0, y0, cw, ch, rw, rh);
    const r = readDigits(img2, rw, rh, { colorMode: mode, strictness: c.strictness, keepMask: c.keepDebug });
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
    if (!r.ok) continue;
    const val = validateReading(r.text, r.conf, c);
    if (!val.ok) {
      if (out.located === located) { out.reason = 'invalid-' + val.why; out.text = r.text; }
      continue;
    }
    track.prev = { cx: bx + bw / 2, cy: by + bh / 2, h: bh };
    track.misses = 0;
    const res = {
      ok: true, value: val.value, text: r.text, conf: r.conf, mode, located,
      quads: r.digits.map((d) => map(d.quad)), bandQuad: map(r.bandQuad), digitHpx: r.digitH * sy,
      rotDeg: r.rotDeg, shear: r.shear, reason: '',
    };
    if (c.keepDebug) res.debug = { ...(out.debug || {}), read: { img: img2, w: rw, h: rh, res: r } };
    return res;
  }
  return out;
}
