import { test } from 'node:test';
import assert from 'node:assert/strict';

const store = {};
globalThis.localStorage = {
  getItem: (k) => store[k] ?? null,
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
const { loadSettings, DEFAULTS } = await import('../js/settings.js');
const KEY = 'tapRate.settings.v1';

test('the old default range is upgraded, a range the user chose is kept', () => {
  store[KEY] = JSON.stringify({ minKg: 10000, maxKg: 30000, targetKgMin: 650 });
  const a = loadSettings();
  assert.equal(a.minKg, DEFAULTS.minKg);
  assert.equal(a.maxKg, DEFAULTS.maxKg);
  assert.equal(a.targetKgMin, 650);

  store[KEY] = JSON.stringify({ minKg: 12000, maxKg: 30000 });
  assert.equal(loadSettings().minKg, 12000);

  // chosen again after the upgrade: kept
  store[KEY] = JSON.stringify({ ...a, minKg: 10000, maxKg: 30000 });
  assert.equal(loadSettings().minKg, 10000);
});

test('the old 2 min / 45 s stop limits move to the new defaults, limits the user chose are kept', () => {
  assert.ok(DEFAULTS.stallSec >= 180 && DEFAULTS.lostSec >= 180, 'a pot change (~2 min) must not end the recording');
  store[KEY] = JSON.stringify({ settingsRev: 2, stallSec: 120, lostSec: 45, targetKgMin: 650 });
  const a = loadSettings();
  assert.deepEqual([a.stallSec, a.lostSec, a.targetKgMin], [DEFAULTS.stallSec, DEFAULTS.lostSec, 650]);

  store[KEY] = JSON.stringify({ settingsRev: 2, stallSec: 300, lostSec: 60 });
  const b = loadSettings();
  assert.deepEqual([b.stallSec, b.lostSec], [300, 60]);

  // chosen again after the upgrade: kept
  store[KEY] = JSON.stringify({ ...a, stallSec: 120, lostSec: 45 });
  const c = loadSettings();
  assert.deepEqual([c.stallSec, c.lostSec], [120, 45]);
});

test('low power mode: a lighter camera stream, fewer readings, slower screen updates', async () => {
  const { powerProfile } = await import('../js/settings.js');
  const normal = powerProfile(DEFAULTS);
  assert.deepEqual([normal.resolution, normal.camFps, normal.procFps, normal.searchFps], ['4k', 30, 10, 10]);
  const low = powerProfile({ ...DEFAULTS, lowPower: true });
  assert.equal(low.low, true);
  assert.deepEqual([low.resolution, low.camFps, low.procFps, low.searchFps, low.videoFps], ['1080p', 15, 3, 1, 3]);
  assert.ok(low.uiMs > normal.uiMs && low.chartMs > normal.chartMs && low.saveMs > normal.saveMs);
  // never more than the user asked for
  const modest = powerProfile({ ...DEFAULTS, lowPower: true, resolution: '720p', procFps: 2, videoFps: 2 });
  assert.deepEqual([modest.resolution, modest.procFps, modest.videoFps], ['720p', 2, 2]);
});
