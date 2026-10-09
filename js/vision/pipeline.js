// Two-stage frame reader: coarse localisation in a downscaled view, then a
// tight, rescaled crop is read digit by digit. With a time stamp, each reading is
// also checked against the recent history of readings (tracker.js).
//
// The pixel source is abstracted as a `sample(x, y, w, h, dw, dh)` function
// returning RGBA pixels of the source rectangle scaled to dw x dh. In the
// browser this is canvas.drawImage(); in Node it is sampler.js.

import { locateDisplay, readDigits, validateReading, expectedDigits, decodeLattice, READ_DEFAULTS } from './sevenseg.js';
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
  // over-exposed digits: thresholds (share of the way from background to the brightest
  // cores) to try when the usual one gives no reading; a value is taken when two agree
  hotThresholds: [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9],
  readDigitH: 46,      // digit height (px) a crop that gave no reading is read again at
  keepDebug: false,
};

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

/**
 * Read one frame.
 * `track` persists between frames (display position, reading history);
 * `t` is the frame time in seconds (enables the temporal consistency checks);
 * `cfg.expect` (optional, from TapEngine.expectation) is where the tap engine expects the weight.
 * Result: {ok, value, how, reason, located, quads, ...}; `how` is one of
 *   ok | prior | locked | jump-accepted                (value given)
 *   locking | jump-pending | digit-slip | unread       (no value)
 */
export function readFrame(sample, srcW, srcH, view, cfg = {}, track = {}, t = null) {
  const c = { ...TRACK_DEFAULTS, ...PIPE_DEFAULTS, ...cfg };
  // auto: red digits, then over-exposed ("hot": white cores in red glow), then any
  // bright digits - starting with whichever mode worked last
  let modes = c.colorMode === 'auto' ? ['red', 'hot', 'bright'] : [c.colorMode];
  if (track.lastMode && modes.includes(track.lastMode)) modes = [track.lastMode, ...modes.filter((m) => m !== track.lastMode)];
  const tracker = c.temporal && t != null ? (track.tracker ||= new DisplayTracker()) : null;
  const pred = tracker ? tracker.predict(t, c, c.expect) : null;
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
    if (r.ok && (pred ? Math.abs(r.value - pred.value) <= pred.band : !tracker?.isSlip(t, r.value, null, c))) break;
    if (pred && tracker.willRescue(t, bestInBand(r.lattice, pred, c), pred, c)) break;
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
    const located = { x: bx, y: by, w: bw, h: bh, edge: cand.touchesEdge };
    const expect = c.expectDigits ?? expectedDigits(c.minKg, c.maxKg, c.multiplier || 1);
    // digit costs for the temporal prior (bright mode is too glare-prone to be rescued)
    const offerLattice = (rr, map) => {
      if (!rr.lattice || out.lattice || mode === 'bright') return;
      out.lattice = rr.lattice;
      out.latLocated = located;
      out.latQuads = rr.digits.map((d) => map(d.quad));
    };
    // read the box with margins of kx, ky box heights, rescaled by rs (confirm: even
    // a reading at the usual threshold needs a second threshold to agree)
    const readScaled = (kx, ky, rs, confirm = false) => {
      const mx = kx * bh + 2 / fx, my = ky * bh + 2 / fy;
      const x0 = Math.max(0, bx - mx), y0 = Math.max(0, by - my);
      const x1 = Math.min(srcW, bx + bw + mx), y1 = Math.min(srcH, by + bh + my);
      const cw = x1 - x0, ch = y1 - y0;
      if (cw < 4 || ch < 4) return null;
      if (cw * rs > c.maxReadW) rs = c.maxReadW / cw;
      const rw = Math.max(8, Math.round(cw * rs)), rh = Math.max(8, Math.round(ch * rs));
      const img2 = sample(x0, y0, cw, ch, rw, rh);
      const sx = cw / rw, sy = ch / rh;
      const map = (q) => (q ? q.map(([x, y]) => [x0 + x * sx, y0 + y * sy]) : null);
      const cache = {};
      const readAt = (relThr) => {
        // "bright" mode also sees glare and unlit segments, so demand clearer digits there
        const r = readDigits(img2, rw, rh, {
          colorMode: mode, strictness: c.strictness, keepMask: c.keepDebug, expectDigits: expect,
          maxDigits: String(Math.round(c.maxKg / (c.multiplier || 1))).length, cache,
          ...(relThr ? { relThr, refRelThr: READ_DEFAULTS.relThr } : {}),
          ...(mode === 'bright' ? { minMargin: 0.8, maxCost: 1.3 } : {}),
        });
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
        return { r, val };
      };
      let { r, val } = readAt(0);
      const first = r;
      offerLattice(r, map);
      // How much of the glow around over-exposed digits clears the usual threshold
      // depends on the exposure: in a heavy glow a 5 looks like a 9 and the digits run
      // together, while only the hottest cores show their shape. So when the usual
      // threshold gives no reading, try higher ones. A value counts only when two
      // thresholds read it and none reads anything else: a misread caused by the glow
      // (or by a dim stroke dropping out) comes and goes with the threshold.
      let why = '';
      if ((!val.ok || confirm) && mode === 'hot' && c.hotThresholds?.length) {
        const prefer = (track.hotThr || []).filter((x) => c.hotThresholds.includes(x));
        const order = [...prefer, ...c.hotThresholds.filter((x) => !prefer.includes(x))];
        const seen = new Map();
        if (val.ok) {
          seen.set(val.value, [{ t: READ_DEFAULTS.relThr, r, val }]);
          val = { ok: false, why: 'unconfirmed' };
        }
        for (const t of order) {
          const a = readAt(t);
          offerLattice(a.r, map);
          if (!a.val.ok) continue;
          if (seen.size && !seen.has(a.val.value)) { why = 'unstable'; break; }
          if (!seen.has(a.val.value)) seen.set(a.val.value, []);
          const agree = seen.get(a.val.value);
          agree.push({ t, ...a });
          if (agree.length === 2) {
            ({ r, val } = agree[0]);
            r.conf = Math.min(r.conf, agree[1].r.conf);
            track.hotThr = agree.map((x) => x.t);
            break;
          }
        }
        if (!val.ok && !why && seen.size) why = 'unconfirmed';
      }
      return { r, val, why, first, img2, rw, rh, sy, map };
    };
    // A digit-cell of margin on both sides: a shorter reading than the range allows is
    // only trusted if the cell where its missing leading digit would be is visibly empty.
    // Over-exposed digits are thin cores: read them at a higher resolution.
    const target = mode === 'hot' ? c.digitTargetH * 1.6 : c.digitTargetH;
    const rs0 = clamp(target / Math.max(1, bh), 0.2, 4);
    let p = readScaled(1.0, 0.35, rs0);
    if (!p) continue;
    if (!out.located) {
      out.located = located;
      out.reason = p.val.ok ? out.reason : p.why || (p.first.ok ? 'invalid-' + p.val.why : p.first.reason);
      out.text = p.first.text;
      out.digitHpx = p.first.digitH * p.sy;
      if (c.keepDebug) out.debug.read = { img: p.img2, w: p.rw, h: p.rh, res: p.first };
    }
    // The crop comes from the red blob found, which may or may not take in the glow (or
    // the whole window) around the digits - so with the framing, both the scale of the
    // digits and how much background the crop holds vary, and the thresholds come from
    // that background. Over-exposed digits that gave no reading are read once more with
    // more background around them, at the usual digit height. A second chance is also a
    // second chance to misread, so there every reading needs a second threshold to agree.
    const H1 = p.first.digitH;
    if (!p.val.ok && H1 > 0 && mode === 'hot') {
      const p2 = readScaled(1.4, 0.7, rs0 * clamp(c.readDigitH / H1, 0.5, 2), true);
      if (p2?.val.ok) p = p2;
    }
    if (!p.val.ok) continue;
    const { r, val, map } = p;
    track.prev = { cx: bx + bw / 2, cy: by + bh / 2, h: bh };
    track.misses = 0;
    const res = {
      ok: true, value: val.value, text: r.text, conf: r.conf, mode, located, decoded: !!val.decoded,
      quads: r.digits.map((d) => map(d.quad)), bandQuad: map(r.bandQuad), digitHpx: r.digitH * p.sy,
      rotDeg: r.rotDeg, shear: r.shear, reason: '',
      lattice: mode !== 'bright' ? r.lattice : null, latLocated: located, latQuads: r.digits.map((d) => map(d.quad)),
    };
    if (c.keepDebug) res.debug = { ...(out.debug || {}), read: { img: p.img2, w: p.rw, h: p.rh, res: r } };
    return res;
  }
  return out;
}
