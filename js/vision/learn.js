// Learning what the digits look like on this display, from what the person said.
//
// When the person tells the app what the display showed - answering its question,
// correcting it, or labelling a picture in Review - the reader's measurements of each
// digit it was not sure of, or got wrong (how much of each of the 7 segments was lit,
// sevenseg.js), are kept with the digit it really was. Digits that look alike (close in
// those 7 numbers) are pooled into one "look". Once the person has said the same digit
// about a look in two answers, and nearly never another one, the reader takes that look
// as one more way the digit appears on this display - also the next time the app is
// opened.
//
// The reader uses a look only for a glyph closer to it than to the shape of every other
// digit (sevenseg.js): there the digit fits better in the costs the constrained decoding
// and the probabilities use (pipeline.js, posterior.js), and reading another digit is
// doubtful, so the frame is not read on its own. A look never makes a reading clear by
// itself, and one mistaken answer teaches nothing.

export const LEARN_DEFAULTS = {
  poolL1: 0.6,       // measurements this close (summed over the 7 segments) are one look
  minVotes: 2,       // a look is used once the person said the same digit about it this often,
  minShare: 0.8,     // ... and this share of all they said about it
  maxLooks: 300,     // kept on the phone (the oldest, least used go first)
};

const l1 = (a, b) => {
  let s = 0;
  for (let i = 0; i < 7; i++) s += Math.abs(a[i] - b[i]);
  return s;
};
const total = (votes) => Object.values(votes).reduce((a, b) => a + b, 0);
const r3 = (x) => Math.round(x * 1000) / 1000;

/**
 * What to learn from a reading the person labelled: [{mode, v, d}] for each glyph
 * whose digit the reader was not sure of, or got wrong. lattice: {n, costs, nv, mode}
 * (sevenseg.js), value in kg, cfg: multiplier, minMargin, maxCost.
 */
export function lessons(lattice, value, cfg = {}) {
  if (!lattice?.nv || !lattice.mode || typeof value !== 'number') return [];
  const ds = String(Math.round(value / (cfg.multiplier || 1)));
  if (ds.length !== lattice.n) return []; // a digit lost or added: no telling which is which
  const margin = cfg.minMargin ?? 0.6, maxCost = cfg.maxCost ?? 1.7;
  const out = [];
  for (let i = 0; i < lattice.n; i++) {
    const v = lattice.nv[i];
    if (!v) continue; // (a narrow "1" is read by its shape, not by segments)
    const d = +ds[i], c = Array.from(lattice.costs[i]);
    const others = c.filter((_, k) => k !== d);
    const sure = c[d] <= maxCost && Math.min(...others) - c[d] >= margin;
    if (!sure) out.push({ mode: lattice.mode, v: Array.from(v, r3), d });
  }
  return out;
}

/** lessons() from every colour mode the frame was read in (readFrame's res.lattices). */
export function lessonsOf(res, value, cfg = {}) {
  const lats = res?.lattices?.length ? res.lattices : res?.lattice ? [res.lattice] : [];
  return lats.flatMap((L) => lessons(L, value, cfg));
}

/** The looks learned on this phone. */
export class DigitMemory {
  constructor(state = null, cfg = {}) {
    this.c = { ...LEARN_DEFAULTS, ...cfg };
    this.looks = Array.isArray(state?.looks) ? state.looks.filter((L) => L && Array.isArray(L.v) && L.v.length === 7) : [];
    this.answers = state?.answers || 0;
    // (ids are never reused: a picture in Review keeps the ids its label taught)
    this.nextId = Math.max(state?.nextId || 1, ...this.looks.map((L) => (L.id || 0) + 1));
    this.cache = null;
  }

  toJSON() { return { v: 1, answers: this.answers, nextId: this.nextId, looks: this.looks }; }

  /**
   * Learn from one answer: lessons() of its reading. One answer is one vote for a look,
   * however many of its digits showed it (25,550 has three 5s). Returns what unlearn()
   * needs.
   */
  learn(items, t = Date.now()) {
    if (!items.length) return [];
    const tokens = [];
    for (const { mode, v, d } of items) {
      let best = null, bd = Infinity;
      for (const L of this.looks) {
        if (L.mode !== mode) continue;
        const dd = l1(L.v, v);
        if (dd < bd) { bd = dd; best = L; }
      }
      let look = best;
      if (!look || bd > this.c.poolL1) {
        look = { id: this.nextId++, mode, v: v.slice(), n: 1, votes: {}, t };
        this.looks.push(look);
      } else {
        const n = look.n || 1; // (the look is the mean of what was seen)
        look.v = look.v.map((x, i) => r3((x * n + v[i]) / (n + 1)));
        look.n = n + 1;
      }
      look.t = t;
      if (tokens.some((k) => k.id === look.id && k.d === d)) continue;
      look.votes[d] = (look.votes[d] || 0) + 1;
      tokens.push({ id: look.id, d });
    }
    this.answers++;
    this.trim();
    this.cache = null;
    return tokens;
  }

  /** Take back an answer (a mistaken tap, a label changed). */
  unlearn(tokens) {
    if (!tokens?.length) return;
    let found = false;
    for (const { id, d } of tokens) {
      const L = this.looks.find((x) => x.id === id);
      if (!L || !L.votes[d]) continue; // (forgotten, or dropped as the oldest)
      found = true;
      if (--L.votes[d] === 0) delete L.votes[d];
      if (!total(L.votes)) this.looks.splice(this.looks.indexOf(L), 1);
    }
    if (found) this.answers = Math.max(0, this.answers - 1);
    this.cache = null;
  }

  forget() { this.looks = []; this.answers = 0; this.cache = null; }

  /** The looks in use, per colour mode: {red: [{d, v}], hot: [...]} (for sevenseg.js). */
  active() {
    if (this.cache) return this.cache;
    const out = {};
    for (const L of this.looks) {
      const n = total(L.votes);
      let d = null, k = 0;
      for (const [dd, kk] of Object.entries(L.votes)) if (kk > k) { d = +dd; k = kk; }
      if (k >= this.c.minVotes && k / n >= this.c.minShare) (out[L.mode] ||= []).push({ d, v: L.v });
    }
    this.cache = out;
    return out;
  }

  stats() {
    const a = this.active();
    return { answers: this.answers, looks: this.looks.length, used: Object.values(a).reduce((s, x) => s + x.length, 0) };
  }

  // at most maxLooks: the oldest of those with the fewest votes go first
  trim() {
    const extra = this.looks.length - this.c.maxLooks;
    if (extra <= 0) return;
    const drop = new Set([...this.looks].sort((x, y) => total(x.votes) - total(y.votes) || x.t - y.t).slice(0, extra));
    this.looks = this.looks.filter((L) => !drop.has(L));
  }
}
