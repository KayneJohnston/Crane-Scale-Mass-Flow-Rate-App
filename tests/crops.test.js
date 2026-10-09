import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { cropKind, CropPolicy, cropRect, cropRecord, choicesFor, reviewOrder, reviewStats, cropsToDrop, exportFiles, CropStore } from '../js/crops.js';
import { makeZip, readZip, crc32 } from '../js/zip.js';

const box = { x: 100, y: 50, w: 300, h: 80 };

test('which frames are kept for review', () => {
  assert.equal(cropKind({ ok: false, located: box, how: 'unread', reason: 'unknown-glyph' }), 'unread');
  assert.equal(cropKind({ ok: true, located: box, how: 'prior', value: 25800, conf: 0.97 }), 'unsure');
  assert.equal(cropKind({ ok: false, located: box, how: 'jump-pending', reason: 'jump-pending' }), 'refused');
  assert.equal(cropKind({ ok: false, located: box, how: 'digit-slip', reason: 'digit-slip' }), 'refused');
  assert.equal(cropKind({ ok: true, located: box, how: 'ok', value: 25800 }), 'sample');
  assert.equal(cropKind({ ok: false, located: box, how: 'locking' }), null);
  assert.equal(cropKind({ ok: false, located: box, reason: 'edge' }), null); // cut off: nothing to read
  assert.equal(cropKind({ ok: false, located: null, reason: 'not-found' }), null);
});

test('at most one crop of a kind every few seconds, and a few every ten minutes', () => {
  const P = new CropPolicy({ perWindow: 4 });
  const unread = { ok: false, located: box, how: 'unread', reason: 'x' };
  const clear = { ok: true, located: box, how: 'ok', value: 20000 };
  assert.equal(P.consider(unread, 10), 'unread');
  assert.equal(P.consider(unread, 11), null);
  assert.equal(P.consider(clear, 11), 'sample');
  assert.equal(P.consider(clear, 40), null); // clear readings once a minute
  assert.equal(P.consider(unread, 13.1), 'unread');
  assert.equal(P.consider(clear, 71.5), 'sample');
  assert.equal(P.consider(unread, 20), null); // 4 kept in the last 10 minutes
  assert.equal(P.consider(unread, 609), null);
  assert.equal(P.consider(unread, 611), 'unread'); // the first one is 10 minutes old
  P.reset();
  assert.equal(P.consider(unread, 0), 'unread');
});

test('the crop: the display with a margin, inside the frame, scaled to fit', () => {
  const r = cropRect(box, 1920, 1080);
  assert.deepEqual([r.x, r.y, r.w, r.h], [52, 18, 396, 144]);
  assert.ok(r.outH <= 160 && r.outW <= 640 && Math.abs(r.outW / r.outH - r.w / r.h) < 0.05);
  const edge = cropRect({ x: 5, y: 1000, w: 300, h: 70 }, 1920, 1080);
  assert.equal(edge.x, 0);
  assert.equal(edge.y + edge.h, 1080);
  const big = cropRect({ x: 400, y: 300, w: 1600, h: 400 }, 3840, 2160);
  assert.ok(big.outW <= 640 && big.outH <= 160);
});

test('what is kept about a crop, and the answers offered', () => {
  const res = {
    ok: true, value: 25800, how: 'prior', conf: 0.97123, strict: null, mode: 'hot', located: box,
    candidates: [{ v: 25800, p: 0.97123 }, { v: 25850, p: 0.02 }, { v: 25700, p: 0.005 }],
    pred: { value: 25812.4, band: 157.2, external: false },
    lattice: { n: 5, costs: [Float64Array.from([3, 7.31, 1, 2, 4, 4, 3, 3, 2, 3])] },
  };
  const c = cropRecord(res, 'unsure', { t: 12.3456, wall: 1700000000000, source: 'camera', rect: cropRect(box, 1920, 1080) });
  assert.equal(c.kind, 'unsure');
  assert.equal(c.value, 25800);
  assert.equal(c.conf, 0.9712);
  assert.equal(c.label, null);
  assert.deepEqual(c.pred, { value: 25812, band: 157, external: false });
  assert.deepEqual(c.lattice[0].slice(0, 3), [3, 7.31, 1]);
  assert.deepEqual(choicesFor(c), [25800, 25850, 25700, 25750]);
  // unread: the runners-up, a clear reading that was not believed, the expected value
  const u = { value: null, candidates: [{ v: 21800, p: 0.6 }], strict: 2180, pred: { value: 21790, band: 150 } };
  assert.deepEqual(choicesFor(u), [21800, 2180, 21750, 21850]);
  assert.deepEqual(choicesFor({ value: null, candidates: null, pred: { value: 21740, band: 150 } }), [21750, 21700, 21800]);
});

const crop = (id, kind, wall, label = null, extra = {}) => ({ id, kind, wall, label, value: null, how: null, ...extra });

test('review order, statistics and what makes room', () => {
  const list = [
    crop('a', 'sample', 1, null, { value: 100, how: 'ok' }),
    crop('b', 'unsure', 2, 200, { value: 200, how: 'prior' }),
    crop('c', 'unread', 3, null, { candidates: [{ v: 300, p: 0.6 }] }),
    crop('d', 'unsure', 4, null, { value: 400, how: 'prior' }),
    crop('e', 'unread', 5, 500, { candidates: [{ v: 500, p: 0.8 }] }),
    crop('f', 'unsure', 6, 650, { value: 600, how: 'prior' }),
    crop('g', 'refused', 7, 'unreadable'),
  ];
  assert.deepEqual(reviewOrder(list).map((c) => c.id), ['c', 'd', 'a']);
  const s = reviewStats(list);
  assert.equal(s.todo, 3);
  assert.equal(s.labelled, 4);
  assert.equal(s.unreadable, 1);
  assert.deepEqual([s.guessed, s.guessedRight, s.unread, s.withTop, s.topRight], [2, 1, 1, 1, 1]);
  assert.deepEqual(cropsToDrop(list, 5), ['a', 'c']); // the clear sample first, never a labelled one
  assert.deepEqual(cropsToDrop(list, 7), []);
  assert.deepEqual(cropsToDrop(list, 2), ['a', 'c', 'd']);
});

test('zip: CRC-32 and a round trip', () => {
  const data = new TextEncoder().encode('The quick brown fox jumps over the lazy dog');
  assert.equal(crc32(data), 0x414fa339);
  if (typeof zlibCrc32 === 'function') assert.equal(crc32(data), zlibCrc32(data));
  const png = new Uint8Array(3000).map((_, i) => (i * 37) & 255);
  const zip = makeZip([{ name: 'crops/0001_25800.png', data: png }, { name: 'labels.csv', data: 'file,label\n' }]);
  const files = readZip(zip);
  assert.deepEqual(files.map((f) => f.name), ['crops/0001_25800.png', 'labels.csv']);
  assert.deepEqual([...files[0].data], [...png]);
  assert.equal(new TextDecoder().decode(files[1].data), 'file,label\n');
});

test('export: pictures named by their label, a table and the details', () => {
  const list = [
    crop('a', 'unsure', 2000, 25800, { value: 25800, how: 'prior', conf: 0.97, candidates: [{ v: 25800, p: 0.97 }] }),
    crop('b', 'unread', 1000, null, { reason: 'unknown-glyph' }),
    crop('c', 'refused', 3000, 'unreadable', { strict: 2180, how: 'digit-slip' }),
  ];
  const images = new Map([['a', new Uint8Array([1, 2])], ['b', new Uint8Array([3])], ['c', new Uint8Array([4])]]);
  const files = exportFiles(list, images, { version: 'test' });
  assert.deepEqual(files.map((f) => f.name), ['crops/0001_unlabelled.png', 'crops/0002_25800.png', 'crops/0003_unreadable.png', 'labels.csv', 'crops.json']);
  const csv = files[3].data.trim().split('\n');
  assert.equal(csv.length, 4);
  assert.match(csv[2], /^crops\/0002_25800\.png,25800,unsure,25800,prior,0\.97,25800:0\.97,/);
  const json = JSON.parse(files[4].data);
  assert.equal(json.kind, 'crops');
  assert.equal(json.crops[2].strict, 2180);
  assert.equal(json.crops[1].label, 25800);
});

test('the crop store keeps the details and pictures apart (in memory without IndexedDB)', async () => {
  const st = await new CropStore().open();
  await st.add(crop('a', 'unread', 1), new Uint8Array([9, 9]).buffer);
  await st.add(crop('b', 'unsure', 2), new Uint8Array([7]).buffer);
  assert.deepEqual((await st.list()).map((c) => c.id), ['b', 'a']);
  const [b] = await st.list();
  b.label = 25800;
  await st.update(b);
  assert.equal((await st.list())[0].label, 25800);
  assert.deepEqual([...new Uint8Array(await st.image('a'))], [9, 9]);
  await st.delete(['a']);
  assert.equal(await st.image('a'), null);
  assert.equal((await st.list()).length, 1);
});
