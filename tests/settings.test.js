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
