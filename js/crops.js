// Hard frames for review: crops of the display from frames the reader could not read,
// did not believe, or read only as the most probable value (posterior.js) - and now
// and then a clear one to compare with. They stay on the phone for someone who saw the
// display to say what it showed (the Review tab); exported, the labelled pictures show
// how the reader does on the real display, and become its test cases.

export const CROP_DEFAULTS = {
  maxCrops: 200,          // kept on the phone: the oldest unlabelled go first, labelled ones never
  perWindow: 20,          // at most this many in windowSec (spread over a long session, not all from its start)
  windowSec: 600,
  gapSec: { unread: 3, refused: 3, unsure: 3, sample: 60 }, // between two crops of a kind
  maxW: 640, maxH: 160,   // a crop is scaled down to fit (digits stay 80+ px tall)
};

// for the list: what to review first
export const KIND_ORDER = { unread: 0, refused: 1, unsure: 2, sample: 3, asked: 4, corrected: 5 };

/** Is this reading (from readFrame) worth keeping for review, and as what? */
export function cropKind(res) {
  if (!res || !res.located) return null;
  if (res.how === 'prior') return 'unsure';           // the most probable value was given
  if (res.ok) return 'sample';                         // a clear reading, for comparison
  if (res.how === 'jump-pending' || res.how === 'digit-slip') return 'refused';
  if (res.how === 'locking') return null;              // the first frames of every start
  const r = res.reason || '';
  if (r === 'edge' || r === 'small' || r === 'no-display' || r === 'not-found') return null; // nothing to read
  return 'unread';
}

/** Which frames to keep: one of a kind every gapSec at most, and perWindow every windowSec. */
export class CropPolicy {
  constructor(cfg = {}) { this.c = { ...CROP_DEFAULTS, ...cfg }; this.reset(); }

  reset() { this.last = {}; this.kept = []; }

  /** The kind of crop to keep from this frame (time t in s), or null. */
  consider(res, t) {
    const kind = cropKind(res);
    if (!kind) return null;
    const prev = this.last[kind];
    if (prev != null && t >= prev && t - prev < (this.c.gapSec[kind] ?? 3)) return null;
    while (this.kept.length && !(t >= this.kept[0] && t - this.kept[0] < this.c.windowSec)) this.kept.shift();
    if (this.kept.length >= this.c.perWindow) return null;
    this.last[kind] = t;
    this.kept.push(t);
    return kind;
  }
}

/** The part of the frame to keep: the display found, with a margin, scaled to fit. */
export function cropRect(located, srcW, srcH, cfg = CROP_DEFAULTS) {
  const m = located.h;
  const x0 = Math.max(0, Math.floor(located.x - 0.6 * m)), y0 = Math.max(0, Math.floor(located.y - 0.4 * m));
  const x1 = Math.min(srcW, Math.ceil(located.x + located.w + 0.6 * m)), y1 = Math.min(srcH, Math.ceil(located.y + located.h + 0.4 * m));
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const s = Math.min(1, cfg.maxW / w, cfg.maxH / h);
  return { x: x0, y: y0, w, h, outW: Math.max(1, Math.round(w * s)), outH: Math.max(1, Math.round(h * s)) };
}

const r4 = (x) => Math.round(x * 1e4) / 1e4;

/** What the app made of the frame, to keep with its picture (img added once encoded). */
export function cropRecord(res, kind, { t, wall, source, rect }) {
  return {
    id: `c${wall.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
    wall, t: Math.round(t * 1000) / 1000, source, kind,
    how: res.how ?? null,
    value: res.ok ? res.value : null,                         // the value given
    conf: res.how === 'prior' && res.conf != null ? r4(res.conf) : null, // ... and its probability, if guessed
    strict: res.strict ?? null,                               // a clear reading that was not believed
    reason: res.ok ? null : res.reason ?? null,
    mode: res.mode ?? null,
    candidates: res.candidates ? res.candidates.map(({ v, p }) => ({ v, p: r4(p) })) : null,
    pred: res.pred ? { value: Math.round(res.pred.value), band: Math.round(res.pred.band), external: !!res.pred.external } : null,
    // the reader's per-digit costs (sevenseg.js), for checking the probabilities
    lattice: res.lattice?.costs ? res.lattice.costs.map((row) => Array.from(row, (x) => Math.round(x * 100) / 100)) : null,
    rect: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null,
    w: rect?.outW ?? null, h: rect?.outH ?? null,
    label: null,       // what the display showed (kg), or 'unreadable'
    labelledAt: null,
  };
}

/**
 * The values to offer as one-tap answers: the app's own, its runners-up, a clear
 * reading it did not believe, the expected value and its neighbours.
 */
export function choicesFor(crop, stepKg = 50) {
  const out = [];
  const add = (v) => { if (v != null && Number.isFinite(v) && v > 0 && !out.includes(v)) out.push(v); };
  add(crop.value);
  for (const c of crop.candidates || []) add(c.v);
  add(crop.strict);
  if (crop.pred) {
    const e = Math.round(crop.pred.value / stepKg) * stepKg;
    add(e); add(e - stepKg); add(e + stepKg);
  }
  return out.slice(0, 4);
}

/** Crops to review, most useful first: the unread, then those not believed, then guesses. */
export function reviewOrder(crops) {
  return crops.filter((c) => c.label == null)
    .sort((a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9) || b.wall - a.wall);
}

/** How the app did on the labelled crops. */
export function reviewStats(crops) {
  const s = { total: crops.length, todo: 0, labelled: 0, unreadable: 0, guessed: 0, guessedRight: 0, clear: 0, clearRight: 0, unread: 0, withTop: 0, topRight: 0, answered: 0 };
  for (const c of crops) {
    if (c.label == null) { s.todo++; continue; }
    s.labelled++;
    if (c.kind === 'asked' || c.kind === 'corrected') s.answered++; // labelled while filming
    if (c.label === 'unreadable') { s.unreadable++; continue; }
    if (c.how === 'prior') { s.guessed++; if (c.value === c.label) s.guessedRight++; }
    else if (c.value != null) { s.clear++; if (c.value === c.label) s.clearRight++; }
    else {
      s.unread++;
      if (c.candidates?.length) { s.withTop++; if (c.candidates[0].v === c.label) s.topRight++; }
    }
  }
  return s;
}

const csv = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const pad = (n, k = 2) => String(n).padStart(k, '0');
function localTime(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * The files of an export: crops/NNNN_<label>.png, labels.csv (one row per picture) and
 * crops.json (everything known about each). images: id -> PNG bytes.
 */
export function exportFiles(crops, images, about = {}) {
  const list = [...crops].sort((a, b) => a.wall - b.wall);
  const files = [], rows = [], meta = [];
  rows.push(['file', 'label', 'kind', 'app_value', 'app_decision', 'probability', 'most_probable', 'not_believed', 'reason', 'expected', 'colour_mode', 'source', 'time'].join(','));
  list.forEach((c, i) => {
    const img = images.get(c.id);
    if (!img) return;
    const lab = c.label == null ? 'unlabelled' : c.label === 'unreadable' ? 'unreadable' : String(c.label);
    const file = `crops/${pad(i + 1, 4)}_${lab}.png`;
    files.push({ name: file, data: img, date: new Date(c.wall) });
    rows.push([
      file, c.label ?? '', c.kind, c.value ?? '', c.how ?? '', c.conf ?? '',
      (c.candidates || []).map((x) => `${x.v}:${x.p}`).join(' '), c.strict ?? '', c.reason ?? '',
      c.pred ? `${c.pred.value}±${c.pred.band}${c.pred.external ? ' (tap rate)' : ''}` : '', c.mode ?? '', c.source ?? '', localTime(c.wall),
    ].map(csv).join(','));
    meta.push({ file, ...c });
  });
  files.push({ name: 'labels.csv', data: rows.join('\n') + '\n' });
  files.push({ name: 'crops.json', data: JSON.stringify({ app: 'tap-rate', kind: 'crops', ...about, exported: new Date().toISOString(), crops: meta }) });
  return files;
}

/**
 * The crops on the phone (IndexedDB "tap-rate-crops", apart from the recordings): what
 * is known about each in one store, the pictures in another, so the list loads fast.
 * Kept in memory if IndexedDB is not available.
 */
export class CropStore {
  constructor() { this.db = null; this.mem = { meta: new Map(), img: new Map() }; this.ready = Promise.resolve(); }

  /** Connect; every other call waits for this (so the app needn't). */
  open() {
    this.ready = this.connect();
    return this.ready.then(() => this);
  }

  async connect() {
    if (typeof indexedDB === 'undefined') return;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('tap-rate-crops', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('img')) db.createObjectStore('img');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB unavailable, review crops kept in memory only', e);
      this.db = null;
    }
  }

  tx(stores, mode, fn) {
    return new Promise((resolve, reject) => {
      const t = this.db.transaction(stores, mode);
      let out;
      const r = fn(t);
      if (r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  /** Add a crop: meta (from cropRecord) and its picture (PNG bytes, ArrayBuffer). */
  async add(meta, img) {
    await this.ready;
    if (!this.db) { this.mem.meta.set(meta.id, { ...meta }); this.mem.img.set(meta.id, img); return; }
    await this.tx(['meta', 'img'], 'readwrite', (t) => { t.objectStore('meta').put(meta); t.objectStore('img').put(img, meta.id); });
  }

  /** Change what is known about a crop (its label). */
  async update(meta) {
    await this.ready;
    if (!this.db) { this.mem.meta.set(meta.id, { ...meta }); return; }
    await this.tx(['meta'], 'readwrite', (t) => t.objectStore('meta').put(meta));
  }

  /** Everything known about every crop, newest first (no pictures). */
  async list() {
    await this.ready;
    const all = this.db ? (await this.tx(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) || [] : [...this.mem.meta.values()].map((m) => ({ ...m }));
    return all.sort((a, b) => b.wall - a.wall);
  }

  /** The picture of a crop (ArrayBuffer of a PNG), or null. */
  async image(id) {
    await this.ready;
    if (!this.db) return this.mem.img.get(id) || null;
    return (await this.tx(['img'], 'readonly', (t) => t.objectStore('img').get(id))) || null;
  }

  async delete(ids) {
    await this.ready;
    ids = [].concat(ids);
    if (!ids.length) return;
    if (!this.db) { for (const id of ids) { this.mem.meta.delete(id); this.mem.img.delete(id); } return; }
    await this.tx(['meta', 'img'], 'readwrite', (t) => { for (const id of ids) { t.objectStore('meta').delete(id); t.objectStore('img').delete(id); } });
  }
}

/**
 * Crops to delete to keep at most max: the oldest unlabelled samples of clear readings
 * first, then the oldest unlabelled others. Labelled crops are never dropped.
 */
export function cropsToDrop(crops, max) {
  const extra = crops.length - max;
  if (extra <= 0) return [];
  const pool = crops.filter((c) => c.label == null)
    .sort((a, b) => (a.kind === 'sample' ? 0 : 1) - (b.kind === 'sample' ? 0 : 1) || a.wall - b.wall);
  return pool.slice(0, extra).map((c) => c.id);
}
