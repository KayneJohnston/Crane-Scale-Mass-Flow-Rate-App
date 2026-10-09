import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decodePNG } from '../tools/png.js';
import { makeSampler } from '../js/vision/sampler.js';
import { readFrame } from '../js/vision/pipeline.js';

// Crops of photos and of video frames of the real crane scale, taken from the floor:
// over-exposed digits (white cores in a red glow), indicator LEDs left of the digits,
// a bright line along the window's frame, glare on the glass. The video frames come
// from a 1080p clip with the digits only ~33 px tall; the screen crops from the app's
// own camera view at 12.6x zoom, with the display showing dashes at 21,800 ("-2-1800.",
// the app's overlay painted out). [file, value shown, must read]: a fixture that
// need not read may be refused, but is never read as a wrong value.
const CASES = [
  ['photo-3050-a.png', 3050, true],
  ['photo-3050-b.png', 3050, true],
  ['photo-3050-c.png', 3050, true],
  ['photo-25700-a.png', 25700, false],
  ['photo-25700-b.png', 25700, true],
  ['photo-25700-c.png', 25700, true],
  ['photo-25800.png', 25800, true],
  ['photo-25850.png', 25850, true],
  ['photo-25950-a.png', 25950, true],
  ['photo-25950-b.png', 25950, true],
  ['video-25700.png', 25700, true],
  ['video-25800.png', 25800, true],
  ['video-25850.png', 25850, true],
  ['video-25900.png', 25900, true],
  ['video-25950.png', 25950, true],
  ['screen-21800-a.png', 21800, true],
  ['screen-21800-b.png', 21800, true],
];

function read(file) {
  const { width: w, height: h, data } = decodePNG(readFileSync(new URL(`fixtures/real/${file}`, import.meta.url)));
  return readFrame(makeSampler(data, w, h), w, h, { x: 0, y: 0, w, h }, {});
}

test('photos and video frames of the real display: read correctly, never misread', () => {
  const missed = [];
  for (const [file, value, mustRead] of CASES) {
    const r = read(file);
    if (r.ok) assert.equal(r.value, value, `${file} read as ${r.value}`);
    else if (mustRead) missed.push(`${file} (${r.reason})`);
  }
  assert.deepEqual(missed, []);
});
