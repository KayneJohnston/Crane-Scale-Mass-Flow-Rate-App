// Asking the person filming what the display shows, when the reader can't tell.
//
// The person stands where they can read the display by eye. When the display has been
// found but no value has come for a few seconds, the Live screen asks "What does the
// display show?" with three likely values. The answer counts as a reading (tracker.js
// told()), and its picture goes to Review already labelled (crops.js).
//
// So that it never nags: a question closes by itself after a while, or as soon as the
// app reads the display again; after an answer it waits before asking again, after
// "Not now" or "Can't tell" longer, and questions left unanswered make it wait longer
// each time.

export const ASK_DEFAULTS = {
  afterSec: 3,                  // display found, no value for this long: ask
  openSec: 12,                  // a question closes by itself after this
  manualSec: 30,                // ... one the person opened (to correct a reading) after this
  otherSec: 20,                 // ... while choosing another value, after this without a tap
  undoSec: 4,                   // an answer can be taken back for this long
  guardMs: 300,                 // taps right after a question appears were meant for something else
  quietAfterAnswer: 15,         // no new question for this long after an answer,
  quietAfterRead: 10,           // ... after the app read the display again by itself,
  quietNotNow: 60,              // ... after "Not now" or "Can't tell",
  quietIgnored: [30, 60, 120, 300], // ... after questions left unanswered, longer each time
};

/** Is this reading (from readFrame) one the person could help with? */
export function isUnclear(res) {
  if (!res || res.ok || !res.located) return false;
  // nothing to read: the badge already says what to do (re-aim, zoom in)
  const r = res.reason || '';
  return !(r === 'edge' || r === 'small' || r === 'no-display' || r === 'not-found');
}

/** When to ask. Times in s, on the clock of the frames. */
export class AskPolicy {
  constructor(cfg = {}) { this.c = { ...ASK_DEFAULTS, ...cfg }; this.reset(); }

  reset() { this.since = null; this.quietUntil = -Infinity; this.ignored = 0; }

  /** A frame was read; true when a question should open now (allowed: by the settings). */
  frame(res, t, allowed = true) {
    if (!isUnclear(res)) { this.since = null; return false; }
    if (this.since == null || t < this.since) this.since = t;
    return allowed && t - this.since >= this.c.afterSec && t >= this.quietUntil;
  }

  quiet(t, sec) { this.since = null; this.quietUntil = t + sec; }

  // how a question ended
  answered(t) { this.ignored = 0; this.quiet(t, this.c.quietAfterAnswer); }
  readAgain(t) { this.quiet(t, this.c.quietAfterRead); }
  notNow(t) { this.quiet(t, this.c.quietNotNow); }
  timedOut(t) {
    const q = this.c.quietIgnored;
    this.quiet(t, q[Math.min(this.ignored, q.length - 1)]);
    this.ignored++;
  }
}

/**
 * The three values to offer, low to high. When the picture says something (its most
 * probable value at least 30% probable, and the readings narrow enough to judge it):
 * its likely values (each at least 5%), then a clear reading that was not believed,
 * the expected value and the neighbours of the first of these. Otherwise - a long spell
 * without readings, a digit half hidden - the expected value and its neighbours first.
 * correct: the person is correcting the value shown, which comes first.
 * cfg: stepKg, minKg, maxKg; fallback: a value to start from when nothing else is known.
 */
export function askChoices(res, cfg = {}, { correct = false, fallback = null } = {}) {
  const step = cfg.stepKg || 50, lo = cfg.minKg ?? 0, hi = cfg.maxKg ?? Infinity;
  const out = [];
  const add = (v) => {
    if (v == null || !Number.isFinite(v)) return;
    v = Math.round(v / step) * step;
    if (v >= lo && v <= hi && v > 0 && !out.includes(v)) out.push(v);
  };
  const likely = (res?.candidates || []).filter((c) => c.p >= 0.05);
  const pred = res?.pred;
  const telling = likely.length > 0 && likely[0].p >= 0.3 && (!pred || pred.band <= 6 * step);
  if (correct && res?.ok) add(res.value);
  if (telling) for (const c of likely) add(c.v);
  add(res?.strict);
  add(pred?.value);
  add(fallback);
  if (out.length) { const b = out[0]; add(b - step); add(b + step); }
  return out.slice(0, 3).sort((x, y) => x - y);
}

/**
 * The values as text, split so the characters that differ between them can be
 * highlighted: [[{t: '21,', hi: false}, {t: '7', hi: true}, {t: '00', hi: false}], ...].
 * Only one or two differing digits are marked: more would mark everything.
 */
export function digitParts(values, fmt = (v) => v.toLocaleString('en-US')) {
  const texts = values.map(fmt);
  const n = Math.max(0, ...texts.map((s) => s.length));
  // right-aligned: the same place value lines up
  const at = (s, i) => s[s.length - n + i];
  let differs = [...Array(n).keys()].map((i) => texts.some((s) => at(s, i) !== at(texts[0], i)));
  if (differs.filter(Boolean).length > 2) differs = differs.map(() => false);
  return texts.map((s) => {
    const parts = [];
    for (let i = 0; i < s.length; i++) {
      const hi = differs[n - s.length + i];
      const last = parts[parts.length - 1];
      if (last && last.hi === hi) last.t += s[i]; else parts.push({ t: s[i], hi });
    }
    return parts;
  });
}
