#!/usr/bin/env node
// Benchmark of live tap-rate estimators against the app's Kalman filter.
//
//   node tools/filter-bench/run.mjs                    tune on taps 101-112, test on 201-230
//   node tools/filter-bench/run.mjs --quick            fewer taps (a rough look)
//   node tools/filter-bench/run.mjs --only Kalman,Holt only estimators whose name has one of these
//   node tools/filter-bench/run.mjs --json out.json    also save every number
//
// Each estimator's settings are chosen on the tuning taps (lowest error averaged over
// the kinds of tap) and it is then scored on different, unseen test taps.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCENARIOS, makeCase, buildSim, runEstimator, score, rms } from './harness.mjs';
import { ESTIMATORS as CANDIDATES, REFERENCES } from './estimators.mjs';

const ESTIMATORS = [...CANDIDATES, ...REFERENCES];

const CACHE_V = 4; // bump when the harness or the engine changes
const cacheDir = path.join(os.tmpdir(), 'tap-filter-bench');

function loadCase(scenario, seed) {
  const f = path.join(cacheDir, `v${CACHE_V}-${scenario}-${seed}.json`);
  let c;
  try {
    c = JSON.parse(fs.readFileSync(f, 'utf8'));
    c.R = Float64Array.from(c.R);
  } catch {
    c = makeCase(scenario, seed);
    fs.mkdirSync(cacheDir, { recursive: true });
    const { sim, ...rest } = c;
    fs.writeFileSync(f, JSON.stringify({ ...rest, R: Array.from(c.R) }));
    return c;
  }
  c.sim = buildSim(scenario, seed);
  return c;
}

function summarise(s, res) {
  const abs = s.e.map(Math.abs).sort((a, b) => a - b);
  const sum = (a, f = (x) => x) => a.reduce((t, x) => t + f(x), 0);
  return {
    n: s.e.length, se2: sum(s.e, (x) => x * x), bias: sum(s.e), se20: sum(s.e20, (x) => x * x), n20: s.e20.length,
    nCov: s.cover.length, cov: sum(s.cover), nBand: s.bands.length, band: sum(s.bands),
    p95: abs.length ? abs[Math.floor(0.95 * (abs.length - 1))] : NaN, maxAbs: s.maxAbs,
    resp: s.resp, jit: s.jit, flips: s.flips, flipsTrue: s.flipsTrue, us: res.us,
  };
}

// ------------------------------------------------------------------ worker --
if (!isMainThread) {
  const { jobs, only } = workerData;
  for (const { scenario, seed, phase } of jobs) {
    const c = loadCase(scenario, seed);
    const out = [];
    ESTIMATORS.forEach((E, ei) => {
      if (!only.includes(ei)) return;
      E.grid.forEach((p, gi) => {
        const res = runEstimator(E.make(p), c);
        if (res) out.push({ ei, gi, sum: summarise(score(c, res), res) });
      });
    });
    parentPort.postMessage({ scenario, seed, phase, out });
  }
  process.exit(0);
}

// -------------------------------------------------------------------- main --
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
const quick = args.includes('--quick');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const tuneSeeds = quick ? range(101, 104) : range(101, 112);
const testSeeds = quick ? range(201, 208) : range(201, 230);
const filt = opt('--only')?.split(',').map((x) => x.trim().toLowerCase());
const only = ESTIMATORS.map((E, i) => i).filter((i) => !filt || filt.some((f) => ESTIMATORS[i].name.toLowerCase().includes(f)));
if (filt && !only.includes(0)) only.unshift(0); // always compare with the shipped filter
const scen = Object.keys(SCENARIOS);

const jobs = [];
for (const phase of ['tune', 'test']) for (const seed of phase === 'tune' ? tuneSeeds : testSeeds) for (const scenario of scen) jobs.push({ scenario, seed, phase });
const nW = Math.max(1, Math.min(os.cpus().length, 8));
const results = { tune: {}, test: {} }; // [phase][ei][gi][scenario] -> [summary per tap]
const t0 = Date.now();
let done = 0;
await Promise.all(Array.from({ length: nW }, (_, w) => new Promise((resolve, reject) => {
  const mine = jobs.filter((_, j) => j % nW === w);
  const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { jobs: mine, only } });
  wk.on('message', ({ scenario, seed, phase, out }) => {
    for (const { ei, gi, sum } of out) {
      const R = ((results[phase][ei] ??= {})[gi] ??= {});
      (R[scenario] ??= []).push({ seed, ...sum });
    }
    done++;
    if (done % 20 === 0) process.stderr.write(`  ${done}/${jobs.length} taps (${((Date.now() - t0) / 1000).toFixed(0)} s)\n`);
  });
  wk.on('error', reject);
  wk.on('exit', resolve);
})));

// ----------------------------------------------------------------- scoring --
const pooled = (list) => Math.sqrt(list.reduce((s, x) => s + x.se2, 0) / Math.max(1, list.reduce((s, x) => s + x.n, 0)));
const pooledBy = (list, k, n) => list.reduce((s, x) => s + x[k], 0) / Math.max(1, list.reduce((s, x) => s + x[n], 0));
const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const objective = (byScen) => avg(scen.map((s) => pooled(byScen[s] || [])));

// choose each estimator's settings on the tuning taps
const chosen = {};
for (const ei of only) {
  const E = ESTIMATORS[ei];
  let best = null;
  E.grid.forEach((p, gi) => {
    const o = objective(results.tune[ei][gi]);
    if (!best || o < best.o) best = { gi, o };
  });
  const tuneErr = E.grid.map((p, gi) => objective(results.tune[ei][gi]));
  // settings whose best value is the smallest or largest one tried
  const edge = Object.keys(E.grid[0]).filter((k) => {
    const vals = [...new Set(E.grid.map((g) => g[k]))].sort((a, b) => a - b);
    return vals.length > 1 && (E.grid[best.gi][k] === vals[0] || E.grid[best.gi][k] === vals[vals.length - 1]);
  });
  chosen[ei] = { ...best, p: E.grid[best.gi], tuneErr, edge };
}

// test-set numbers with the chosen settings
const pct = (x, d = 1) => (Number.isFinite(x) ? (100 * x).toFixed(d) : '-');
const report = [];
for (const ei of only) {
  const E = ESTIMATORS[ei], ch = chosen[ei], byScen = results.test[ei][ch.gi];
  const all = scen.flatMap((s) => byScen[s]);
  const perScen = Object.fromEntries(scen.map((s) => [s, pooled(byScen[s])]));
  const steps = (byScen.steps || []).flatMap((x) => x.resp);
  report.push({
    ei, name: E.name, family: E.family, reference: !!E.reference, params: ch.p, edge: ch.edge,
    perScen, mean: avg(scen.map((s) => perScen[s])),
    e20: avg(scen.map((s) => Math.sqrt(pooledBy(byScen[s], 'se20', 'n20')))),
    bias: avg(scen.map((s) => pooledBy(byScen[s], 'bias', 'n'))),
    band: pooledBy(all, 'band', 'nBand'), cover: pooledBy(all, 'cov', 'nCov'),
    p95: avg(all.map((x) => x.p95)), worst: Math.max(...all.map((x) => x.maxAbs)),
    stepResp: steps.length ? avg(steps) : NaN,
    jit: avg(all.map((x) => x.jit)), flips: avg(all.map((x) => x.flips)), flipsTrue: avg(all.map((x) => x.flipsTrue)),
    us: avg(all.map((x) => x.us)),
    // robustness to its own setting: test error at the best and worst grid point
    gridRange: E.grid.map((p, gi) => avg(scen.map((s) => pooled(results.test[ei][gi][s])))),
    taps: Object.fromEntries(scen.map((s) => [s, Object.fromEntries(byScen[s].map((x) => [x.seed, Math.sqrt(x.se2 / Math.max(1, x.n))]))])),
  });
}

// paired comparison with the shipped filter, tap by tap (bootstrap over taps)
const base = report.find((r) => r.ei === 0);
function paired(r) {
  const d = [];
  for (const s of scen) for (const seed of Object.keys(r.taps[s])) d.push(r.taps[s][seed] - base.taps[s][seed]);
  const wins = d.filter((x) => x < 0).length / d.length;
  let rnd = 12345;
  const rand = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648);
  const bs = [];
  for (let b = 0; b < 2000; b++) { let s = 0; for (let i = 0; i < d.length; i++) s += d[Math.floor(rand() * d.length)]; bs.push(s / d.length); }
  bs.sort((a, b) => a - b);
  return { wins, mean: avg(d), lo: bs[50], hi: bs[1949] };
}
for (const r of report) r.vsShipped = r.ei === 0 ? null : paired(r);
report.sort((a, b) => a.reference - b.reference || a.mean - b.mean);

// ------------------------------------------------------------------ output --
const abbrev = { standard: 'std', nearTarget: 'near', steps: 'steps', noisy: 'noisy', clean: 'clean', lowPower: 'lowpw', messy: 'messy' };
const w0 = Math.max(...report.map((r) => r.name.length)) + 1;
console.log(`\nTest taps: ${testSeeds.length} per kind x ${scen.length} kinds; settings chosen on ${tuneSeeds.length} other taps per kind. (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
console.log('\nRMS error of the live rate vs the true rate, % (lower is better)');
console.log('#  ' + 'estimator'.padEnd(w0) + scen.map((s) => abbrev[s].padStart(6)).join('') + '   mean  vs 20s  bias   band  flips(true)  jitter  p95  worst  step  cover    us   win  diff [95% CI]');
report.forEach((r, k) => {
  const v = r.vsShipped;
  console.log(
    String(k + 1).padEnd(3) + r.name.padEnd(w0) + scen.map((s) => pct(r.perScen[s]).padStart(6)).join('') +
    pct(r.mean, 2).padStart(7) + pct(r.e20).padStart(7) + pct(r.bias).padStart(6) + pct(r.band).padStart(7) +
    `${r.flips.toFixed(2)}(${r.flipsTrue.toFixed(2)})`.padStart(13) + r.jit.toFixed(1).padStart(7) +
    pct(r.p95).padStart(6) + pct(r.worst, 0).padStart(6) + (Number.isFinite(r.stepResp) ? r.stepResp.toFixed(1) : '-').padStart(6) +
    pct(r.cover, 0).padStart(6) + r.us.toFixed(1).padStart(6) +
    (v ? `${pct(v.wins, 0).padStart(5)}% ${(100 * v.mean >= 0 ? '+' : '') + (100 * v.mean).toFixed(2)} [${(100 * v.lo).toFixed(2)}, ${(100 * v.hi).toFixed(2)}]` : '     (reference)'),
  );
});
console.log('\nChosen settings (tuning taps); *k = best value of k is the smallest or largest tried; test error over its range of settings');
for (const r of report) {
  const g = r.gridRange.filter(Number.isFinite);
  console.log('   ' + r.name.padEnd(w0) + (JSON.stringify(r.params) + r.edge.map((k) => ' *' + k).join('')).padEnd(40) + `${pct(Math.min(...g), 2)} .. ${pct(Math.max(...g), 2)}`);
}
const jsonOut = opt('--json');
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ tuneSeeds, testSeeds, scenarios: scen, report, chosen }, null, 1));
