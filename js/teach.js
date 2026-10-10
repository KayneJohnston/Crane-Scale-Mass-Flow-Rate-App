// Teach mode: pictures and short clips of the scale display while the camera reads,
// kept on the phone and sent to a GitHub repository the person sets up (a private
// one), so the reader can be tested and improved on their display: other angles,
// distances, light, glare and fumes.
//
// What is kept (TeachPolicy):
//  - a picture of the camera box every stillSec while the display is in view, and of
//    frames the reader could not read or was not sure of at most every hardSec (those
//    teach the most); each with a full-resolution picture of the display and its
//    surroundings;
//  - clips: clipSec of the display at every frame read, as a sequence of pictures of
//    one place in the camera frame (so the reader can read it again frame by frame, as
//    the app did): when the readings stop while the display is in view, and every
//    clipEverySec anyway;
//  - what the app read in every frame, and what the person said the display showed.
// At most dayMB is saved a day and keepMB kept on the phone (the oldest go first).
//
// Sending (GitHubSink): zips of about batchMB, one commit each, while the camera is off.
// A public repository is refused: anyone could see the pictures.

import { cropKind } from './crops.js';

export const TEACH_DEFAULTS = {
  stillSec: 20,        // a picture of the camera box this often while the display is in view,
  hardSec: 5,          // ... and of a frame the reader can't read or isn't sure of, at most this often
  clipSec: 6,          // a clip: this long, every frame read
  unclearSec: 1,       // ... when the display has been in view this long without a reading,
  clipGapSec: 120,     //     at most one this often
  clipEverySec: 300,   // ... and this long after the last clip anyway
  dayMB: 150,          // saved at most this much a day
  keepMB: 400,         // kept on the phone at most (the oldest pictures go first)
  viewMaxW: 1280,      // pictures of the camera box at most this wide
  displayMaxW: 1600,   // pictures of the display at most this wide (else full resolution)
  margin: 1,           // ... with this many of its heights around it
  batchMB: 12,         // sent in zips of about this size
  maxInFlight: 6,      // pictures being encoded at once (more: this frame's are skipped)
};

const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const r2 = (x) => Math.round(x * 100) / 100;

/** What to keep of each frame read. */
export class TeachPolicy {
  constructor(cfg = {}) { this.c = { ...TEACH_DEFAULTS, ...cfg }; this.reset(); }

  reset() {
    this.lastStill = -Infinity; this.lastHard = -Infinity; this.lastClip = -Infinity; this.lastUnclear = -Infinity;
    this.clip = null; this.unclearSince = null; this.seenT = -Infinity; this.clips = 0;
  }

  /**
   * res: readFrame's result, T: the frame's time (s), budget: false once the day's
   * allowance is used up (nothing is kept, a clip under way ends), clips: whether to make
   * clips. Returns {still: 'still' | 'hard' | null, clip: {n: the clip's number, i: the
   * frame's, why: 'unclear' | 'regular'} | null}.
   */
  frame(res, T, { budget = true, clips = true } = {}) {
    const c = this.c;
    const seen = !!res?.located && !res.located.edge;
    if (seen) this.seenT = T;
    if (res?.ok) this.unclearSince = null;
    else if (seen) this.unclearSince ??= T;
    const out = { still: null, clip: null };
    if (!budget) { this.clip = null; return out; }
    if (this.clip && T - this.clip.t0 >= c.clipSec) this.clip = null;
    // a clip needs the display's place: seen in the last 2 s
    if (!this.clip && clips && T - this.seenT <= 2) {
      const unclear = this.unclearSince != null && T - this.unclearSince >= c.unclearSec && T - this.lastUnclear >= c.clipGapSec;
      if (unclear || (seen && T - this.lastClip >= c.clipEverySec)) {
        this.clip = { n: ++this.clips, t0: T, i: 0, why: unclear ? 'unclear' : 'regular' };
        this.lastClip = T;
        if (unclear) this.lastUnclear = T;
      }
    }
    if (this.clip) out.clip = { n: this.clip.n, i: this.clip.i++, why: this.clip.why };
    // pictures, while the display is (or just was) in view: not of wherever the phone points
    if (T - this.seenT <= 10) {
      const kind = cropKind(res);
      if (kind && kind !== 'sample' && T - this.lastHard >= c.hardSec) { out.still = 'hard'; this.lastHard = T; }
      if (T - this.lastStill >= c.stillSec) { out.still ??= 'still'; this.lastStill = T; }
    }
    return out;
  }
}

/**
 * The picture of the display: it with `margin` of its heights around it, inside the
 * camera frame and `within` (the camera box), at most displayMaxW wide.
 */
export function teachRect(box, srcW, srcH, cfg = TEACH_DEFAULTS, within = null) {
  const m = cfg.margin * box.h;
  const L = within ? Math.max(0, within.x) : 0, T = within ? Math.max(0, within.y) : 0;
  const R = within ? Math.min(srcW, within.x + within.w) : srcW, B = within ? Math.min(srcH, within.y + within.h) : srcH;
  const x0 = Math.max(L, Math.floor(box.x - m)), y0 = Math.max(T, Math.floor(box.y - m));
  const x1 = Math.min(R, Math.ceil(box.x + box.w + m)), y1 = Math.min(B, Math.ceil(box.y + box.h + m));
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) return null;
  const s = Math.min(1, cfg.displayMaxW / w);
  return { x: x0, y: y0, w, h, outW: Math.max(1, Math.round(w * s)), outH: Math.max(1, Math.round(h * s)) };
}

/** The picture of the camera box (view: the part of the camera frame the reader reads). */
export function viewPicture(view, cfg = TEACH_DEFAULTS) {
  const s = Math.min(1, cfg.viewMaxW / view.w);
  return { x: Math.round(view.x), y: Math.round(view.y), w: Math.round(view.w), h: Math.round(view.h), outW: Math.max(1, Math.round(view.w * s)), outH: Math.max(1, Math.round(view.h * s)) };
}

const box = (b) => (b ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : null);

/** What the app made of a frame, to keep with its pictures (in camera-frame pixels). */
export function readingOf(res) {
  if (!res) return null;
  return {
    ok: !!res.ok, value: res.ok ? res.value : null, how: res.how ?? null, conf: res.conf != null ? r4(res.conf) : null,
    strict: res.strict ?? null, reason: res.ok ? null : res.reason ?? null, mode: res.mode ?? null,
    located: box(res.located), digitHpx: res.digitHpx != null ? r2(res.digitHpx) : null,
    rotDeg: res.rotDeg != null ? r2(res.rotDeg) : null, shear: res.shear != null ? r4(res.shear) : null,
    candidates: res.candidates ? res.candidates.map(({ v, p }) => ({ v, p: r4(p) })) : null,
    pred: res.pred ? { value: Math.round(res.pred.value), band: Math.round(res.pred.band) } : null,
    // the reader's fit of each glyph to each digit and its segment fills, in every colour mode
    lattices: res.lattices?.length ? res.lattices.map((L) => ({ mode: L.mode, n: L.n, nv: L.nv, costs: L.costs.map((row) => Array.from(row, r2)) })) : null,
  };
}

/**
 * The next batch to send: pictures in time order, a clip's all together, up to about
 * maxBytes (at least one picture or clip), with the readings and the person's answers
 * of their time (and 30 s either side). records: everything kept (TeachStore.list()).
 * Returns {samples, logs, answers, bytes} or null when nothing is left to send.
 */
export function nextBatch(records, maxBytes) {
  const samples = records.filter((r) => r.type === 'sample').sort((a, b) => a.wall - b.wall);
  if (!samples.length) return null;
  const groups = [], byClip = new Map();
  for (const s of samples) {
    if (!s.clip) { groups.push([s]); continue; }
    let g = byClip.get(s.clip);
    if (!g) { g = []; byClip.set(s.clip, g); groups.push(g); }
    g.push(s);
  }
  const out = [];
  let bytes = 0;
  for (const g of groups) {
    const b = g.reduce((a, s) => a + (s.bytes || 0), 0);
    if (out.length && bytes + b > maxBytes) break;
    out.push(...g);
    bytes += b;
  }
  const w0 = Math.min(...out.map((s) => s.wall)) - 30000, w1 = Math.max(...out.map((s) => s.wall)) + 30000;
  const logs = records.filter((r) => r.type === 'log' && r.wall1 >= w0 && r.wall0 <= w1);
  const answers = records.filter((r) => r.type === 'answer' && r.wall >= w0 && r.wall <= w1);
  return { samples: out, logs, answers, bytes };
}

/**
 * Readings and answers no longer needed once `sent` (ids) are sent: those more than
 * 30 s before every picture left to send (or more than an hour old if none is left).
 */
export function staleRecords(records, sent, now = Date.now()) {
  const gone = new Set(sent);
  const left = records.filter((r) => r.type === 'sample' && !gone.has(r.id));
  const from = left.length ? Math.min(...left.map((s) => s.wall)) - 30000 : now - 3600e3;
  return records.filter((r) => (r.type === 'log' && r.wall1 < from) || (r.type === 'answer' && r.wall < from)).map((r) => r.id);
}

/**
 * The files of a batch's zip: the pictures (files: Map 'id/name' -> bytes) and
 * teach.json with what is known about each, the readings ([wall ms, kg or null,
 * confidence, how]) and answers of their time. about: app version, display, camera.
 */
export function batchFiles(batch, files, about = {}) {
  const out = [];
  const samples = batch.samples.map((s) => {
    const names = {};
    for (const name of s.files || []) {
      const data = files.get(`${s.id}/${name}`);
      if (!data) continue;
      const file = `frames/${s.id}_${name}.jpg`;
      out.push({ name: file, data, date: new Date(s.wall) });
      names[name] = file;
    }
    const { type, bytes, files: _, ...rest } = s;
    return { ...rest, files: names };
  });
  const seen = new Set();
  const readings = batch.logs.flatMap((l) => l.rows)
    .filter((r) => (seen.has(r[0]) ? false : seen.add(r[0])))
    .sort((a, b) => a[0] - b[0]);
  const answers = batch.answers.map(({ type, ...a }) => a).sort((a, b) => a.wall - b.wall);
  out.push({ name: 'teach.json', data: JSON.stringify({ app: 'tap-rate', kind: 'teach', format: 1, ...about, exported: new Date().toISOString(), samples, readings, answers }) });
  return out;
}

const pad = (n, k = 2) => String(n).padStart(k, '0');

/** Where a batch goes in the repository: teach/2026-10-10/094215_a1b2c3.zip (local time). */
export function batchPath(batch, device, prefix = 'teach') {
  const d = new Date(batch.samples[0].wall);
  return `${prefix}/${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}/${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${device}.zip`;
}

const CLEAR = new Set(['ok', 'locked', 'jump-accepted', 'told']);

/**
 * What the display showed at a picture's time (wall, ms), if it can be known from what
 * was sent with it: {truth: kg | null, from: 'person' | 'readings' | null}. What the person
 * said within 1 s; else the clear readings around it (the app's, or the person's), if the
 * last within gapMs before and the first within gapMs after show the same value: the
 * weight only rises during a tap, so it can't have been anything else in between.
 * readings: [[wall, kg | null, confidence, how]] in time order, answers: [{wall, value}].
 */
export function labelOf(wall, readings, answers, gapMs = 5000) {
  const a = answers.find((x) => Math.abs(x.wall - wall) <= 1000);
  if (a) return { truth: a.value, from: 'person' };
  let before = null, after = null;
  for (const r of readings) {
    if (r[1] == null || !CLEAR.has(r[3])) continue;
    if (r[0] <= wall && wall - r[0] <= gapMs) before = r;
    else if (r[0] > wall && r[0] - wall <= gapMs && !after) after = r;
  }
  if (before && after && before[1] === after[1]) return { truth: before[1], from: 'readings' };
  return { truth: null, from: null };
}

/** "34 pictures, 2 clips (11.2 MB)" */
export function batchSummary(batch) {
  const clips = new Set(batch.samples.filter((s) => s.clip).map((s) => s.clip)).size;
  const pics = batch.samples.filter((s) => !s.clip || s.kind !== 'clip').length;
  const parts = [];
  if (pics) parts.push(`${pics} picture${pics === 1 ? '' : 's'}`);
  if (clips) parts.push(`${clips} clip${clips === 1 ? '' : 's'}`);
  return `${parts.join(', ')} (${(batch.bytes / 1e6).toFixed(1)} MB)`;
}

/** Usage of the kept records: {pictures, clips, bytes, oldest (wall)}. */
export function teachUsage(records) {
  const samples = records.filter((r) => r.type === 'sample');
  return {
    pictures: samples.filter((s) => s.kind !== 'clip').length,
    clips: new Set(samples.filter((s) => s.clip).map((s) => s.clip)).size,
    bytes: samples.reduce((a, s) => a + (s.bytes || 0), 0),
    oldest: samples.length ? Math.min(...samples.map((s) => s.wall)) : null,
  };
}

/** Pictures to delete to keep at most maxBytes: the oldest first, a clip's all together. */
export function teachToDrop(records, maxBytes) {
  const samples = records.filter((r) => r.type === 'sample').sort((a, b) => a.wall - b.wall);
  let bytes = samples.reduce((a, s) => a + (s.bytes || 0), 0);
  const drop = new Set();
  for (const s of samples) {
    if (bytes <= maxBytes) break;
    if (drop.has(s.id)) continue;
    for (const x of s.clip ? samples.filter((y) => y.clip === s.clip) : [s]) {
      if (drop.has(x.id)) continue;
      drop.add(x.id);
      bytes -= x.bytes || 0;
    }
  }
  return [...drop];
}

/**
 * What teach mode keeps on the phone (IndexedDB "tap-rate-teach"): records in one store
 * - pictures ({type: 'sample', id, wall, files: names, bytes, ...}), readings ({type:
 * 'log', wall0, wall1, rows}) and answers ({type: 'answer', wall, value}) - and the
 * pictures' bytes in another ('id/name'). Kept in memory if IndexedDB is not available.
 */
export class TeachStore {
  constructor() { this.db = null; this.mem = { meta: new Map(), file: new Map() }; this.ready = Promise.resolve(); }

  open() {
    this.ready = this.connect();
    return this.ready.then(() => this);
  }

  async connect() {
    if (typeof indexedDB === 'undefined') return;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open('tap-rate-teach', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('file')) db.createObjectStore('file');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    } catch (e) {
      console.warn('IndexedDB unavailable, teach data kept in memory only', e);
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

  /** Keep a record, with its pictures ({name: ArrayBuffer | Uint8Array}). */
  async add(rec, files = {}) {
    await this.ready;
    if (!this.db) {
      this.mem.meta.set(rec.id, { ...rec });
      for (const [name, data] of Object.entries(files)) this.mem.file.set(`${rec.id}/${name}`, data);
      return;
    }
    await this.tx(['meta', 'file'], 'readwrite', (t) => {
      t.objectStore('meta').put(rec);
      for (const [name, data] of Object.entries(files)) t.objectStore('file').put(data, `${rec.id}/${name}`);
    });
  }

  /** Every record (no pictures). */
  async list() {
    await this.ready;
    if (!this.db) return [...this.mem.meta.values()].map((r) => ({ ...r }));
    return (await this.tx(['meta'], 'readonly', (t) => t.objectStore('meta').getAll())) || [];
  }

  /** The pictures of these records: Map 'id/name' -> Uint8Array. */
  async files(recs) {
    await this.ready;
    const keys = recs.flatMap((r) => (r.files || []).map((n) => `${r.id}/${n}`));
    const out = new Map();
    if (!this.db) { for (const k of keys) if (this.mem.file.has(k)) out.set(k, new Uint8Array(this.mem.file.get(k))); return out; }
    await this.tx(['file'], 'readonly', (t) => {
      const st = t.objectStore('file');
      for (const k of keys) {
        const r = st.get(k);
        r.onsuccess = () => { if (r.result) out.set(k, new Uint8Array(r.result)); };
      }
    });
    return out;
  }

  async delete(recs) {
    await this.ready;
    recs = [].concat(recs);
    if (!recs.length) return;
    if (!this.db) {
      for (const r of recs) { this.mem.meta.delete(r.id); for (const n of r.files || []) this.mem.file.delete(`${r.id}/${n}`); }
      return;
    }
    await this.tx(['meta', 'file'], 'readwrite', (t) => {
      for (const r of recs) {
        t.objectStore('meta').delete(r.id);
        for (const n of r.files || []) t.objectStore('file').delete(`${r.id}/${n}`);
      }
    });
  }
}

// ------------------------------------------------------------ GitHub --

/** "owner/name", or a github.com link to it -> {owner, name, full}; null if not one. */
export function parseRepo(s) {
  const m = String(s || '').trim().replace(/^(https?:\/\/)?(www\.)?github\.com\//i, '').replace(/\/+$/, '').replace(/\.git$/i, '').match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1], name: m[2], full: `${m[1]}/${m[2]}` } : null;
}

/** Bytes -> base64 (in pieces: a long argument list overflows the stack). */
export function toBase64(bytes) {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const README = `# Tap Rate teach data

Pictures and clips of the crane-scale display, sent by the Tap Rate app in teach mode,
to test and improve its reader. Each zip holds the pictures (frames/) and teach.json:
what the app read in each, the readings around them and what the person said the
display showed. Keep this repository private.
`;

/** What went wrong, in words for the person. */
function explain(e) {
  if (e.status === 401) return Object.assign(new Error('GitHub refused the token: expired, revoked or mistyped?'), { status: 401 });
  if (e.status === 403 && /rate limit/i.test(e.message)) return Object.assign(new Error('GitHub asks to wait a while (rate limit).'), { status: 403, retry: true });
  if (e.status === 403) return Object.assign(new Error('The token may not write to the repository: give it “Contents: Read and write” for it.'), { status: 403 });
  if (e.status === 404) return Object.assign(new Error('Repository not found, or the token has no access to it.'), { status: 404 });
  if (!e.status) return Object.assign(new Error('No connection to GitHub.'), { retry: true });
  return e;
}

/**
 * A GitHub repository to send files to, with a personal access token (fine-grained,
 * for that repository only, "Contents: Read and write"). Each file is one commit,
 * made with the git data API (blob, tree, commit, branch).
 */
export class GitHubSink {
  constructor({ repo, token, fetch: f } = {}) {
    this.r = parseRepo(repo);
    this.token = String(token || '').trim();
    this.fetch = f || ((...a) => globalThis.fetch(...a));
    this.info = null;
  }

  async req(method, path, body) {
    let res;
    try {
      res = await this.fetch(`https://api.github.com/repos/${this.r.full}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json', Authorization: `Bearer ${this.token}`, 'X-GitHub-Api-Version': '2022-11-28',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw Object.assign(new Error(err?.message || 'network'), { status: 0 });
    }
    let data = null;
    try { data = await res.json(); } catch { /* no body */ }
    if (!res.ok) throw Object.assign(new Error(data?.message || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  /**
   * May the files go there? {full, branch} - throws with what is wrong (a public
   * repository too). write: also write something, as the token, to be sure it may (the
   * repository only tells what its owner may): a blob no commit refers to, or in an
   * empty repository its first commit, a README, which it needs anyway.
   */
  async check({ write = false } = {}) {
    if (!this.r) throw new Error('Type the repository as owner/name.');
    if (!this.token) throw new Error('Paste the access token.');
    let d;
    try { d = await this.req('GET', ''); } catch (e) { throw explain(e); }
    if (!d.private) throw Object.assign(new Error(`${d.full_name} is public: anyone could see the pictures. Make it private, or use another one.`), { public: true });
    if (d.permissions && !d.permissions.push) throw new Error(`The token may not write to ${d.full_name}: give it “Contents: Read and write” for it.`);
    this.info = { full: d.full_name, branch: d.default_branch || 'main' };
    if (write) {
      try {
        if (!(await this.head(this.info.branch))) await this.init();
        else await this.req('POST', '/git/blobs', { content: toBase64(new TextEncoder().encode('Tap Rate: may this token write here?')), encoding: 'base64' });
      } catch (e) { throw e.status !== undefined ? explain(e) : e; }
    }
    return this.info;
  }

  // a repository without any commit takes no blobs: its first file goes in on its own
  async init() {
    await this.req('PUT', '/contents/README.md', { message: 'Tap Rate teach data', content: toBase64(new TextEncoder().encode(README)) });
  }

  async head(branch) {
    try { return (await this.req('GET', `/git/ref/heads/${branch}`)).object.sha; } catch (e) {
      if (e.status === 409 || e.status === 404) return null; // an empty repository
      throw explain(e);
    }
  }

  /** Add (or replace) the file at path in one commit; returns the commit's sha. */
  async put(path, bytes, message) {
    const info = this.info || (await this.check());
    try {
      let head = await this.head(info.branch);
      if (!head) {
        await this.init();
        head = await this.head(info.branch);
      }
      const blob = await this.req('POST', '/git/blobs', { content: toBase64(bytes), encoding: 'base64' });
      for (let attempt = 0; ; attempt++) {
        const base = await this.req('GET', `/git/commits/${head}`);
        const tree = await this.req('POST', '/git/trees', { base_tree: base.tree.sha, tree: [{ path, mode: '100644', type: 'blob', sha: blob.sha }] });
        const commit = await this.req('POST', '/git/commits', { message, tree: tree.sha, parents: [head] });
        try {
          await this.req('PATCH', `/git/refs/heads/${info.branch}`, { sha: commit.sha });
          return commit.sha;
        } catch (e) {
          if (e.status !== 422 || attempt >= 2) throw e;
          head = await this.head(info.branch); // something else was committed meanwhile
        }
      }
    } catch (e) { throw e.status !== undefined ? explain(e) : e; }
  }
}
