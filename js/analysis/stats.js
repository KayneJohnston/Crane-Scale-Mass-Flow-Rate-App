// Robust statistics used by the mass-flow-rate engine.

export function median(a) {
  const n = a.length;
  if (!n) return NaN;
  const s = Float64Array.from(a).sort();
  const m = n >> 1;
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function mean(a) {
  let s = 0;
  for (const x of a) s += x;
  return a.length ? s / a.length : NaN;
}

/** Median absolute deviation scaled to be consistent with a normal sigma. */
export function madSigma(a) {
  if (!a.length) return NaN;
  const m = median(a);
  return 1.4826 * median(a.map((x) => Math.abs(x - m)));
}

/** First index i with arr[i] >= x (arr sorted ascending). */
export function lowerBound(arr, x) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

let pairBuf = new Float64Array(1024);

/**
 * Theil–Sen slope of z vs t over indices [i0, i1) with a standard error.
 *
 * SE = 1.05 * sigma / sqrt(Sxx) * sqrt((1 + rho) / (1 - rho))
 *   sigma: MAD of the residuals (robust), floored at `sigmaFloor`
 *          (quantisation alone gives step/sqrt(12));
 *   1.05:  Theil–Sen is ~91% as efficient as least squares under normal errors;
 *   rho:   lag-1 autocorrelation of the residuals (crane swing etc. makes
 *          neighbouring readings correlated, so there are fewer independent points).
 */
export function robustSlope(t, z, i0 = 0, i1 = t.length, opts = {}) {
  const sigmaFloor = opts.sigmaFloor ?? 14.4;
  let n = i1 - i0;
  if (n < 4) return null;
  // keep the pair count bounded for long windows (deterministic decimation)
  const step = n > 300 ? Math.ceil(n / 300) : 1;
  const idx = [];
  for (let i = i0; i < i1; i += step) idx.push(i);
  n = idx.length;
  const npairs = (n * (n - 1)) / 2;
  if (pairBuf.length < npairs) pairBuf = new Float64Array(Math.ceil(npairs * 1.5));
  let k = 0;
  for (let a = 0; a < n; a++) {
    const ta = t[idx[a]], za = z[idx[a]];
    for (let b = a + 1; b < n; b++) {
      const dt = t[idx[b]] - ta;
      if (dt > 0.2) pairBuf[k++] = (z[idx[b]] - za) / dt;
    }
  }
  if (k < 3) return null;
  const sl = pairBuf.subarray(0, k).sort();
  const ts = k % 2 ? sl[k >> 1] : (sl[(k >> 1) - 1] + sl[k >> 1]) / 2;
  let tm = 0;
  for (let i = i0; i < i1; i++) tm += t[i];
  tm /= i1 - i0;
  // The Theil-Sen line screens out wild readings. The slope itself is then a least-
  // squares fit to the rest: on a coarse display (50 kg steps 10-15 s apart in a slow
  // tap) most pairs share a step and have slope 0, which drags the Theil-Sen median
  // towards zero, while least squares follows the staircase's average climb.
  const off0 = [];
  for (let i = i0; i < i1; i++) off0.push(z[i] - ts * (t[i] - tm));
  const c0 = median(off0);
  const s0 = Math.max(sigmaFloor, 1.4826 * median(off0.map((x) => Math.abs(x - c0))));
  const keep = Math.max(4 * s0, 6 * sigmaFloor);
  let nk = 0, tk = 0, zk = 0;
  for (let i = i0; i < i1; i++) if (Math.abs(off0[i - i0] - c0) <= keep) { nk++; tk += t[i]; zk += z[i]; }
  let slope = ts;
  if (nk >= 4) {
    tk /= nk; zk /= nk;
    let sxy = 0, sxx2 = 0;
    for (let i = i0; i < i1; i++) {
      if (Math.abs(off0[i - i0] - c0) > keep) continue;
      sxy += (t[i] - tk) * (z[i] - zk); sxx2 += (t[i] - tk) ** 2;
    }
    if (sxx2 > 1e-9) slope = sxy / sxx2;
  }
  const off = [];
  for (let i = i0; i < i1; i++) off.push(z[i] - slope * (t[i] - tm));
  const intercept = median(off); // level at tm
  const res = off.map((x) => x - intercept);
  const sigma = Math.max(sigmaFloor, 1.4826 * median(res.map(Math.abs)));
  let sxx = 0;
  for (let i = i0; i < i1; i++) sxx += (t[i] - tm) ** 2;
  let num = 0, den = 0;
  for (let i = 0; i < res.length; i++) {
    den += res[i] * res[i];
    if (i) num += res[i] * res[i - 1];
  }
  const rho = den > 0 ? Math.min(0.9, Math.max(0, num / den)) : 0;
  const infl = Math.sqrt((1 + rho) / (1 - rho));
  const se = (1.05 * sigma * infl) / Math.sqrt(Math.max(sxx, 1e-9));
  return { slope, intercept, tm, se, sigma, rho, n: i1 - i0, span: t[i1 - 1] - t[i0] };
}

/** Ordinary least squares fit z = a + b*h (h a basis value per point). */
function olsBasis(h, z, n) {
  let sh = 0, sz = 0, shh = 0, shz = 0, szz = 0;
  for (let i = 0; i < n; i++) { sh += h[i]; sz += z[i]; shh += h[i] * h[i]; shz += h[i] * z[i]; szz += z[i] * z[i]; }
  const d = n * shh - sh * sh;
  if (Math.abs(d) < 1e-9) return null;
  const b = (n * shz - sh * sz) / d;
  const a = (sz - b * sh) / n;
  const sse = szz - a * sz - b * shz;
  return { a, b, sse, d, n };
}

/**
 * Change-point ("hinge") fit for the start of a tap:  z = a + b * max(0, t - tau).
 * Grid search over tau with a closed-form least-squares fit at each tau.
 * Returns {tau, a (level before), b (rate, kg/s), seB} or null.
 */
export function hingeOnset(t, z, opts = {}) {
  const n = t.length;
  if (n < 8) return null;
  const t0 = t[0], t1 = t[n - 1];
  const step = opts.step ?? Math.max(0.25, (t1 - t0) / 200);
  const h = new Float64Array(n);
  let best = null;
  for (let tau = t0; tau <= t1 - (opts.minTail ?? 4); tau += step) {
    for (let i = 0; i < n; i++) h[i] = t[i] > tau ? t[i] - tau : 0;
    const f = olsBasis(h, z, n);
    if (f && f.b > 0 && (!best || f.sse < best.sse)) best = { ...f, tau };
  }
  if (!best) return null;
  const s2 = Math.max(best.sse, 0) / Math.max(1, n - 3);
  return { tau: best.tau, a: best.a, b: best.b, seB: Math.sqrt((s2 * n) / best.d), sigma: Math.sqrt(s2) };
}

/**
 * Change-point fit for the end of a tap:  z = a + b * (min(t, tau) - t0).
 * Returns {tau, a, b, level (value after tau)} or null.
 */
export function hingeStop(t, z, opts = {}) {
  const n = t.length;
  if (n < 8) return null;
  const t0 = t[0], t1 = t[n - 1];
  const step = opts.step ?? Math.max(0.25, (t1 - t0) / 200);
  const h = new Float64Array(n);
  let best = null;
  for (let tau = t0 + (opts.minHead ?? 4); tau <= t1; tau += step) {
    for (let i = 0; i < n; i++) h[i] = (t[i] < tau ? t[i] : tau) - t0;
    const f = olsBasis(h, z, n);
    if (f && f.b > 0 && (!best || f.sse < best.sse)) best = { ...f, tau };
  }
  if (!best) return null;
  return { tau: best.tau, a: best.a, b: best.b, level: best.a + best.b * (best.tau - t0) };
}

/** Robust noise sigma of a locally-linear series from second differences. */
export function secondDiffSigma(t, z, i0, i1, dtTol = 0.15) {
  const d2 = [];
  for (let i = i0 + 1; i < i1 - 1; i++) {
    const a = t[i] - t[i - 1], b = t[i + 1] - t[i];
    if (a <= 0 || b <= 0 || Math.abs(a - b) > dtTol * Math.max(a, b) || a > 2.5) continue;
    d2.push(z[i + 1] - 2 * z[i] + z[i - 1]);
  }
  if (d2.length < 12) return null;
  // var(z[i+1] - 2 z[i] + z[i-1]) = 6 sigma^2 for independent noise
  return (1.4826 * median(d2.map(Math.abs))) / Math.sqrt(6);
}
