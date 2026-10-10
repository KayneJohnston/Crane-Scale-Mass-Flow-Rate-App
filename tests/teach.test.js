import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TeachPolicy, teachRect, viewPicture, readingOf, nextBatch, staleRecords, batchFiles, batchPath, batchSummary,
  teachUsage, teachToDrop, TeachStore, parseRepo, toBase64, GitHubSink,
} from '../js/teach.js';
import { makeZip, readZip } from '../js/zip.js';

const box = { x: 400, y: 300, w: 200, h: 80 };
const clear = (v = 18550) => ({ ok: true, value: v, how: 'ok', located: box });
const unread = { ok: false, how: 'unread', reason: 'unknown-glyph', located: box };
const gone = { ok: false, how: 'unread', reason: 'not-found', located: null };

test('pictures: every 20 s while the display is in view, hard frames at most every 5 s', () => {
  const P = new TeachPolicy({ clipEverySec: 1e9, clipGapSec: 1e9 });
  const kept = [];
  for (let k = 0; k <= 600; k++) {
    const T = k / 10, res = T >= 30 && T < 45 ? unread : clear();
    const d = P.frame(res, T, { clips: false });
    if (d.still) kept.push([T, d.still]);
  }
  assert.deepEqual(kept, [[0, 'still'], [20, 'still'], [30, 'hard'], [35, 'hard'], [40, 'hard'], [60, 'still']]);
  // not of wherever the phone points: only within 10 s of the display being seen
  const Q = new TeachPolicy();
  assert.equal(Q.frame(gone, 0).still, null);
  Q.frame(clear(), 1);
  assert.equal(Q.frame(gone, 30).still, null);
});

test('clips: when the readings stop, and every 5 minutes anyway', () => {
  const P = new TeachPolicy();
  const frames = [];
  for (let k = 0; k <= 5000; k++) { // 500 s, 10 frames a second
    const T = k / 10, res = (T >= 100 && T < 103) || (T >= 150 && T < 160) ? unread : clear();
    const d = P.frame(res, T);
    if (d.clip) frames.push({ T, ...d.clip });
  }
  const clips = [...new Set(frames.map((f) => f.n))].map((n) => {
    const f = frames.filter((x) => x.n === n);
    return { n, why: f[0].why, from: f[0].T, frames: f.length, numbered: f.every((x, i) => x.i === i) };
  });
  // at the start (none yet), when unclear at 101 s (1 s without a reading), not again at 151 s
  // (within 2 min of the last such), then a regular one 5 min after the last clip
  assert.deepEqual(clips.map((c) => [c.why, c.from]), [['regular', 0], ['unclear', 101], ['regular', 401]]);
  assert.ok(clips.every((c) => c.frames === 60 && c.numbered), '6 s of frames each, numbered');
  // the day's allowance used up: nothing, and a clip under way ends
  const Q = new TeachPolicy();
  assert.ok(Q.frame(clear(), 0).clip);
  assert.deepEqual(Q.frame(clear(), 0.1, { budget: false }), { still: null, clip: null });
  assert.equal(Q.frame(clear(), 0.2).clip, null);
});

test('where the pictures are taken', () => {
  const r = teachRect(box, 1920, 1080);
  assert.deepEqual(r, { x: 320, y: 220, w: 360, h: 240, outW: 360, outH: 240 });
  const edge = teachRect({ x: 10, y: 5, w: 200, h: 80 }, 1920, 1080);
  assert.deepEqual([edge.x, edge.y], [0, 0]);
  const big = teachRect({ x: 500, y: 500, w: 2400, h: 600 }, 3840, 2160);
  assert.ok(big.outW === 1600 && Math.abs(big.outH / big.outW - big.h / big.w) < 0.01, 'at most 1600 px wide');
  assert.equal(teachRect({ x: 0, y: 0, w: 2, h: 1 }, 4, 4), null);
  const inBox = teachRect(box, 1920, 1080, undefined, { x: 350, y: 250, w: 600, h: 400 });
  assert.deepEqual([inBox.x, inBox.y, inBox.x + inBox.w, inBox.y + inBox.h], [350, 250, 680, 460], 'never outside the camera box');
  const v = viewPicture({ x: 100.4, y: 50, w: 2560, h: 1440 });
  assert.deepEqual([v.x, v.outW, v.outH], [100, 1280, 720]);
  const rd = readingOf({ ok: true, value: 18550, how: 'ok', conf: 0.912345, located: { x: 1.4, y: 2, w: 3, h: 4 }, lattices: [{ mode: 'red', n: 1, nv: [[1, 0, 1, 1, 0, 1, 1]], costs: [Float64Array.from({ length: 10 }, (_, i) => i / 3)] }] });
  assert.equal(rd.value, 18550);
  assert.equal(rd.conf, 0.9123);
  assert.deepEqual(rd.located, { x: 1, y: 2, w: 3, h: 4 });
  assert.deepEqual(rd.lattices[0].costs[0].slice(0, 3), [0, 0.33, 0.67]);
});

// records as kept: pictures (100 kB each), a clip of 3 frames, readings and answers
function records() {
  const w = 1.7e12;
  const s = (id, dt, extra = {}) => ({ type: 'sample', id, wall: w + dt * 1000, kind: 'still', clip: null, files: ['view', 'display'], bytes: 100e3, ...extra });
  return [
    s('a', 0), s('b', 20),
    s('c1', 30, { kind: 'clip', clip: 'k1', files: ['display'] }), s('c2', 30.1, { kind: 'hard', clip: 'k1' }), s('c3', 30.2, { kind: 'clip', clip: 'k1', files: ['display'] }),
    s('d', 50), s('e', 3600),
    { type: 'log', id: 'L1', wall0: w - 5000, wall1: w + 25000, rows: [[w, 18500, 1, 'ok'], [w + 100, null, 0, 'unread']] },
    { type: 'log', id: 'L2', wall0: w + 25000, wall1: w + 55000, rows: [[w + 30000, 18550, 0.98, 'prior']] },
    { type: 'log', id: 'L3', wall0: w + 3590e3, wall1: w + 3600e3, rows: [[w + 3600e3, 21000, 1, 'ok']] },
    { type: 'answer', id: 'A1', wall: w + 31000, value: 18550, corrected: null },
  ];
}

test('batches: in time order up to the size, a clip all together, with their readings and answers', () => {
  const R = records();
  const b1 = nextBatch(R, 350e3);
  assert.deepEqual(b1.samples.map((s) => s.id), ['a', 'b'], 'the clip would go over: it waits for the next batch');
  assert.deepEqual(b1.logs.map((l) => l.id), ['L1', 'L2']);
  assert.deepEqual(b1.answers.map((a) => a.id), ['A1']);
  const b2 = nextBatch(R.filter((r) => !['a', 'b'].includes(r.id)), 350e3);
  assert.deepEqual(b2.samples.map((s) => s.id), ['c1', 'c2', 'c3']);
  assert.equal(nextBatch(R, 1).samples.length, 1, 'at least one picture, however large');
  assert.equal(nextBatch(R.filter((r) => r.type !== 'sample'), 1e6), null);
  assert.equal(batchSummary(b2), '1 picture, 1 clip (0.3 MB)');
  assert.equal(batchSummary(b1), '2 pictures (0.2 MB)');
  // L1 is still needed with d (it reaches into the 30 s before it); once d is sent too,
  // only e is left, an hour later
  assert.deepEqual(staleRecords(R, ['a', 'b', 'c1', 'c2', 'c3']), []);
  assert.deepEqual(staleRecords(R, ['a', 'b', 'c1', 'c2', 'c3', 'd']), ['L1', 'L2', 'A1']);
  assert.deepEqual(staleRecords(R.filter((r) => r.type !== 'sample'), [], 1.7e12 + 7300e3).sort(), ['A1', 'L1', 'L2', 'L3']);
  const u = teachUsage(R);
  assert.deepEqual(u, { pictures: 5, clips: 1, bytes: 700e3, oldest: 1.7e12 });
  assert.deepEqual(teachToDrop(R, 450e3), ['a', 'b', 'c1', 'c2', 'c3'], 'the oldest first, the clip all together');
  assert.deepEqual(teachToDrop(R, 1e9), []);
});

test('a batch as a zip: the pictures and teach.json', () => {
  const R = records();
  const b = nextBatch(R, 1e9);
  const files = new Map();
  for (const s of b.samples) for (const n of s.files) files.set(`${s.id}/${n}`, Uint8Array.of(0xff, 0xd8, s.id.charCodeAt(0)));
  const out = batchFiles(b, files, { version: '0.7.0', device: 'abc123' });
  const zip = readZip(makeZip(out));
  const json = JSON.parse(new TextDecoder().decode(zip.find((f) => f.name === 'teach.json').data));
  assert.equal(zip.filter((f) => f.name.endsWith('.jpg')).length, 12);
  assert.deepEqual(json.samples.find((s) => s.id === 'c1').files, { display: 'frames/c1_display.jpg' });
  assert.equal(json.samples[0].bytes, undefined);
  assert.deepEqual(json.readings.map((r) => r[1]), [18500, null, 18550, 21000]);
  assert.deepEqual(json.answers, [{ id: 'A1', wall: 1.7e12 + 31000, value: 18550, corrected: null }]);
  assert.equal(json.device, 'abc123');
  const d = new Date(1.7e12);
  assert.match(batchPath(b, 'abc123'), new RegExp(`^teach/${d.getFullYear()}-\\d\\d-\\d\\d/\\d{6}_abc123\\.zip$`));
});

test('the store keeps records and pictures (in memory without IndexedDB)', async () => {
  const st = await new TeachStore().open();
  await st.add({ type: 'sample', id: 's1', wall: 1, files: ['view'], bytes: 3 }, { view: Uint8Array.of(1, 2, 3).buffer });
  await st.add({ type: 'log', id: 'l1', wall0: 0, wall1: 1, rows: [] });
  assert.equal((await st.list()).length, 2);
  const f = await st.files([{ id: 's1', files: ['view'] }]);
  assert.deepEqual([...f.get('s1/view')], [1, 2, 3]);
  await st.delete([{ id: 's1', files: ['view'] }]);
  assert.deepEqual((await st.list()).map((r) => r.id), ['l1']);
  assert.equal((await st.files([{ id: 's1', files: ['view'] }])).size, 0);
});

test('repository names and base64', () => {
  assert.deepEqual(parseRepo('kayne/teach-data'), { owner: 'kayne', name: 'teach-data', full: 'kayne/teach-data' });
  assert.equal(parseRepo('https://github.com/kayne/teach-data.git/').full, 'kayne/teach-data');
  assert.equal(parseRepo('teach-data'), null);
  assert.equal(parseRepo('a/b/c'), null);
  const bytes = Uint8Array.from({ length: 70000 }, (_, i) => (i * 7) % 256);
  assert.equal(toBase64(bytes), Buffer.from(bytes).toString('base64'));
  // (the browser's way, without Buffer)
  const B = globalThis.Buffer;
  try { globalThis.Buffer = undefined; assert.equal(toBase64(bytes.subarray(5)), B.from(bytes.subarray(5)).toString('base64')); } finally { globalThis.Buffer = B; }
});

// a fake GitHub: one repository, its branch and objects; records every request
function fakeGitHub({ isPrivate = true, empty = false, push = true, token = 'tok', raceOnce = false, write = true } = {}) {
  const st = { calls: [], blobs: new Map(), trees: new Map(), commits: new Map(), head: null, n: 0 };
  const id = (p) => `${p}${++st.n}`;
  if (!empty) { st.trees.set('t0', { base: null, entries: [] }); st.commits.set('c0', { tree: 't0', parents: [] }); st.head = 'c0'; }
  let raced = !raceOnce;
  const json = (status, body) => ({ ok: status < 300, status, json: async () => body });
  const fetch = async (url, opt) => {
    const path = url.replace('https://api.github.com/repos/kayne/teach', '');
    const body = opt.body ? JSON.parse(opt.body) : null;
    st.calls.push(`${opt.method} ${path}`);
    if (opt.headers.Authorization !== `Bearer ${token}`) return json(401, { message: 'Bad credentials' });
    if (!write && opt.method !== 'GET') return json(403, { message: 'Resource not accessible by personal access token' });
    if (opt.method === 'GET' && path === '') return json(200, { full_name: 'kayne/teach', private: isPrivate, default_branch: 'main', permissions: { push } });
    if (opt.method === 'GET' && path === '/git/ref/heads/main') return st.head ? json(200, { object: { sha: st.head } }) : json(409, { message: 'Git Repository is empty.' });
    if (opt.method === 'PUT' && path === '/contents/README.md') {
      const t = id('t'), c = id('c');
      st.trees.set(t, { base: null, entries: [{ path: 'README.md' }] });
      st.commits.set(c, { tree: t, parents: [] });
      st.head = c;
      return json(201, { commit: { sha: c } });
    }
    if (opt.method === 'POST' && path === '/git/blobs') { if (empty && !st.head) return json(409, { message: 'Git Repository is empty.' }); const b = id('b'); st.blobs.set(b, body.content); return json(201, { sha: b }); }
    const mc = path.match(/^\/git\/commits\/(\w+)$/);
    if (opt.method === 'GET' && mc) return json(200, { sha: mc[1], tree: { sha: st.commits.get(mc[1]).tree } });
    if (opt.method === 'POST' && path === '/git/trees') { const t = id('t'); st.trees.set(t, { base: body.base_tree, entries: body.tree }); return json(201, { sha: t }); }
    if (opt.method === 'POST' && path === '/git/commits') { const c = id('c'); st.commits.set(c, { tree: body.tree, parents: body.parents, message: body.message }); return json(201, { sha: c }); }
    if (opt.method === 'PATCH' && path === '/git/refs/heads/main') {
      if (!raced) { // someone else commits first
        raced = true;
        const c = id('c');
        st.commits.set(c, { tree: st.commits.get(st.head).tree, parents: [st.head] });
        st.head = c;
      }
      if (st.commits.get(body.sha).parents[0] !== st.head) return json(422, { message: 'Update is not a fast forward' });
      st.head = body.sha;
      return json(200, { object: { sha: body.sha } });
    }
    return json(404, { message: 'Not Found' });
  };
  return { st, fetch };
}

test('sending a file to GitHub: one commit with the file, on top of what is there', async () => {
  const G = fakeGitHub();
  const sink = new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: G.fetch });
  assert.deepEqual(await sink.check(), { full: 'kayne/teach', branch: 'main' });
  const bytes = Uint8Array.of(1, 2, 3, 250);
  const sha = await sink.put('teach/2026-10-10/094215_abc123.zip', bytes, 'Teach data: 1 picture');
  assert.equal(G.st.head, sha);
  const c = G.st.commits.get(sha), tree = G.st.trees.get(c.tree);
  assert.deepEqual(c.parents, ['c0']);
  assert.equal(c.message, 'Teach data: 1 picture');
  assert.equal(tree.base, 't0');
  assert.deepEqual(tree.entries.map((e) => [e.path, e.mode, e.type]), [['teach/2026-10-10/094215_abc123.zip', '100644', 'blob']]);
  assert.equal(G.st.blobs.get(tree.entries[0].sha), Buffer.from(bytes).toString('base64'));
});

test('an empty repository gets its first commit first; a commit made meanwhile is built on', async () => {
  const E = fakeGitHub({ empty: true });
  const s1 = new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: E.fetch });
  await s1.put('teach/a.zip', Uint8Array.of(1), 'first');
  assert.ok(E.st.calls.includes('PUT /contents/README.md'));
  assert.equal(E.st.commits.get(E.st.head).message, 'first');

  const R = fakeGitHub({ raceOnce: true });
  const s2 = new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: R.fetch });
  const sha = await s2.put('teach/b.zip', Uint8Array.of(2), 'second');
  assert.equal(R.st.head, sha);
  assert.equal(R.st.calls.filter((c) => c === 'PATCH /git/refs/heads/main').length, 2, 'tried again on the new head');
  assert.equal(R.st.calls.filter((c) => c === 'POST /git/blobs').length, 1, 'the file is sent once');
});

test('checking with a write: a blob nothing refers to, or the README an empty repository needs', async () => {
  const G = fakeGitHub();
  await new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: G.fetch }).check({ write: true });
  assert.ok(G.st.calls.includes('POST /git/blobs'));
  assert.equal(G.st.head, 'c0', 'no commit');
  const E = fakeGitHub({ empty: true });
  await new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: E.fetch }).check({ write: true });
  assert.ok(E.st.calls.includes('PUT /contents/README.md') && E.st.head, 'an empty repository gets its README');
  // a token that may read but not write: the repository says its owner may push
  await assert.rejects(new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: fakeGitHub({ write: false }).fetch }).check({ write: true }), /may not write.*Contents: Read and write/);
  await new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: fakeGitHub({ write: false }).fetch }).check(); // (without: not found out)
});

test('refused: a public repository, a token that may not write, a wrong token, no connection', async () => {
  const check = (opts, sinkOpts = {}) => new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: fakeGitHub(opts).fetch, ...sinkOpts }).check();
  await assert.rejects(check({ isPrivate: false }), (e) => e.public && /public: anyone could see/.test(e.message));
  await assert.rejects(check({ push: false }), /may not write/);
  await assert.rejects(check({}, { token: 'wrong' }), /refused the token/);
  await assert.rejects(new GitHubSink({ repo: 'kayne', token: 'tok' }).check(), /owner\/name/);
  await assert.rejects(new GitHubSink({ repo: 'kayne/teach', token: '' }).check(), /token/);
  const offline = new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: async () => { throw new TypeError('Failed to fetch'); } });
  await assert.rejects(offline.check(), (e) => e.retry && /No connection/.test(e.message));
  // a public repository never gets a file
  const P = fakeGitHub({ isPrivate: false });
  await assert.rejects(new GitHubSink({ repo: 'kayne/teach', token: 'tok', fetch: P.fetch }).put('x.zip', Uint8Array.of(1), 'x'), /public/);
  assert.ok(!P.st.calls.some((c) => c.startsWith('POST')));
});

test('what the display showed at a picture: what the person said, else the clear readings around it', async () => {
  const { labelOf } = await import('../js/teach.js');
  const w = 1.7e12;
  const readings = [[w - 1500, 18500, 1, 'ok'], [w - 300, null, 0, 'unread'], [w + 200, 18500, 0.97, 'prior'], [w + 900, 18500, 1, 'locked'], [w + 5000, 18550, 1, 'ok']];
  assert.deepEqual(labelOf(w, readings, []), { truth: 18500, from: 'readings' });
  assert.deepEqual(labelOf(w, readings, [{ wall: w + 600, value: 18550 }]), { truth: 18550, from: 'person' });
  assert.deepEqual(labelOf(w + 3000, readings, []), { truth: null, from: null }, 'it changed in between');
  assert.deepEqual(labelOf(w + 3000, readings, [], 1000), { truth: null, from: null }, 'nothing clear close enough');
  assert.deepEqual(labelOf(w + 2000, [[w + 1500, 18500, 1, 'ok'], [w + 2500, 18550, 1, 'ok']], []), { truth: null, from: null }, 'before and after differ: it changed');
  assert.deepEqual(labelOf(w, [[w - 500, 18500, 0.9, 'prior'], [w + 500, 18500, 1, 'ok']], []), { truth: null, from: null }, 'a guess is not clear');
});
