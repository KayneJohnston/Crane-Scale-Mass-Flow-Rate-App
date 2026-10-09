import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('every module the app loads is cached for use offline (sw.js)', () => {
  const sw = readFileSync(join(root, 'sw.js'), 'utf8');
  const seen = new Set(), todo = ['js/main.js'];
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(join(root, f), 'utf8').matchAll(/from '(\.[^']+)'/g)) todo.push(normalize(join(dirname(f), m[1])));
  }
  assert.deepEqual([...seen].filter((f) => !sw.includes(`'${f}'`)), []);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.match(sw, new RegExp(`'tap-rate-v${version.replace(/\./g, '\\.')}'`), 'the cache is named after the version');
  assert.match(readFileSync(join(root, 'js/main.js'), 'utf8'), new RegExp(`VERSION = '${version.replace(/\./g, '\\.')}'`));
});
