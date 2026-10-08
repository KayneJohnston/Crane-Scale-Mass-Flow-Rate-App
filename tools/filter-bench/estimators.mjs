// Candidate live (causal) tap-rate estimators. Each entry: {name, family, grid, make}.
// make(params)(ctx) -> {step(i, T, z, ok) -> {q, sd?}}, with q and sd in kg/s.
// ctx: {init: {T, level, rate}, R: per-reading noise variance (kg^2), stream, seed}.
// Readings the engine rejected (touches, misreads) come with ok = false: estimators
// only move their clock forward on them.

import { robustSlope } from '../../js/analysis/stats.js';
import { rateVarToS } from '../../js/analysis/kalman.js';
import { mulberry32 } from '../../js/vision/render7seg.js';

const QMAX = 50; // kg/s (3000 kg/min): physically impossible above
const clampQ = (q) => (q < 0 ? 0 : q > QMAX ? QMAX : q);

// ------------------------------------------------------ small linear algebra --
const zeros = (n, m) => Array.from({ length: n }, () => new Array(m).fill(0));

function kfPredict(st, F, Q) {
  const n = st.x.length, x = st.x, P = st.P;
  const xn = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) xn[i] += F[i][k] * x[k];
  const FP = zeros(n, n);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) { const f = F[i][k]; if (f) for (let j = 0; j < n; j++) FP[i][j] += f * P[k][j]; }
  const Pn = zeros(n, n);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { let s = Q[i][j]; for (let k = 0; k < n; k++) s += FP[i][k] * F[j][k]; Pn[i][j] = s; }
  st.x = xn; st.P = Pn;
}

function kfUpdate(st, h, z, R) {
  const n = st.x.length, x = st.x, P = st.P;
  const Ph = new Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let k = 0; k < n; k++) Ph[i] += P[i][k] * h[k];
  let S = R, hx = 0;
  for (let k = 0; k < n; k++) { S += h[k] * Ph[k]; hx += h[k] * x[k]; }
  const nu = z - hx;
  for (let i = 0; i < n; i++) x[i] += (Ph[i] / S) * nu;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) P[i][j] -= (Ph[i] * Ph[j]) / S;
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) P[i][j] = P[j][i] = (P[i][j] + P[j][i]) / 2;
  return { nu, S };
}

const Fllt = (dt) => [[1, dt], [0, 1]];
const Qllt = (S, dt) => [[(S * dt ** 3) / 3, (S * dt ** 2) / 2], [(S * dt ** 2) / 2, S * dt]];
const Fca = (dt) => [[1, dt, (dt * dt) / 2], [0, 1, dt], [0, 0, 1]];
const Qca = (S, dt) => [
  [(S * dt ** 5) / 20, (S * dt ** 4) / 8, (S * dt ** 3) / 6],
  [(S * dt ** 4) / 8, (S * dt ** 3) / 3, (S * dt ** 2) / 2],
  [(S * dt ** 3) / 6, (S * dt ** 2) / 2, S * dt],
];
const H2 = [1, 0], H3 = [1, 0, 0], H4 = [1, 0, 1, 0];

// The load swing as a lightly damped oscillator of period P (s) and RMS size sig (kg):
// exact transition over dt and the noise that keeps it going at that size.
function oscModel(P, zeta, sig, dt) {
  const w = (2 * Math.PI) / P, wd = w * Math.sqrt(1 - zeta * zeta), e = Math.exp(-zeta * w * dt);
  const c = Math.cos(wd * dt), s = Math.sin(wd * dt), k = (zeta * w) / wd;
  const F = [[e * (c + k * s), (e * s) / wd], [(-e * w * w * s) / wd, e * (c - k * s)]];
  const P0 = [sig * sig, w * w * sig * sig]; // stationary covariance (diagonal)
  const Q = zeros(2, 2);
  for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) Q[i][j] = (i === j ? P0[i] : 0) - F[i][0] * P0[0] * F[j][0] - F[i][1] * P0[1] * F[j][1];
  return { F, Q, P0 };
}

// [[A, 0], [0, B]]
function blockDiag(A, B) {
  const n = A.length, m = B.length, M = zeros(n + m, n + m);
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) M[i][j] = A[i][j];
  for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) M[n + i][n + j] = B[i][j];
  return M;
}

// every model-based filter starts exactly like the engine's: at the flow onset, from the
// level before the tap and the onset fit's rate, with the same uncertainty
function lltInit(ctx) {
  const { level, rate, Pmm, Pqq, T } = ctx.init;
  return { x: [level, rate], P: [[Pmm, 0], [0, Pqq]], t: T };
}

// a fixed-size window of accepted readings
function windowBuf() {
  const t = [], z = [];
  return {
    t, z,
    push(T, Z) { t.push(T); z.push(Z); },
    trim(from) { let k = 0; while (k < t.length && t[k] < from) k++; if (k) { t.splice(0, k); z.splice(0, k); } },
  };
}

function olsSlope(t, z, T) {
  const n = t.length;
  let st = 0, sz = 0;
  for (let i = 0; i < n; i++) { st += t[i] - T; sz += z[i]; }
  const tm = st / n, zm = sz / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const d = t[i] - T - tm; sxx += d * d; sxy += d * (z[i] - zm); }
  return sxx > 1e-9 ? sxy / sxx : null;
}

// weighted least squares polynomial (degree 1 or 2) in u = (t - T) / W: slope at T
function wlsSlopeAtEnd(t, z, T, W, deg, weight) {
  const k = deg + 1;
  const A = zeros(k, k), b = new Array(k).fill(0);
  for (let i = 0; i < t.length; i++) {
    const u = (t[i] - T) / W, w = weight(u);
    if (!(w > 0)) continue;
    const phi = deg === 2 ? [1, u, u * u] : [1, u];
    for (let r = 0; r < k; r++) { b[r] += w * phi[r] * z[i]; for (let c = 0; c < k; c++) A[r][c] += w * phi[r] * phi[c]; }
  }
  const sol = solve(A, b);
  return sol ? sol[1] / W : null;
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

function gauss(r) {
  let u = 0;
  while (u === 0) u = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

// window estimators: slope over the accepted readings of the last W seconds (from the
// onset on), the onset fit's rate until there are enough of them
function windowed(W, slopeFn) {
  return (ctx) => {
    const buf = windowBuf();
    let q = ctx.init.rate;
    return {
      step(i, T, z, ok) {
        if (ok) buf.push(T, z);
        buf.trim(T - W);
        if (buf.t.length >= 6 && buf.t[buf.t.length - 1] - buf.t[0] >= Math.min(0.4 * W, 8)) {
          const s = slopeFn(buf.t, buf.z, T, W);
          if (s != null && Number.isFinite(s)) q = clampQ(s);
        }
        return { q };
      },
    };
  };
}

// ------------------------------------------------------------------- the list --
const RV = [40, 55, 70, 85, 100, 150, 220];

export const ESTIMATORS = [
  {
    name: 'Kalman (as shipped)', family: 'Kalman', grid: [{}],
    make: () => (ctx) => ({ step: (i) => ({ q: ctx.stream[i].qEng, sd: ctx.stream[i].sdEng }) }),
  },
  {
    name: 'Kalman, same model (retuned)', family: 'Kalman', grid: RV.map((rv) => ({ rv })),
    make: (p) => (ctx) => {
      const S = rateVarToS(p.rv), st = lltInit(ctx);
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) { kfPredict(st, Fllt(dt), Qllt(S, dt)); st.t = T; }
          if (ok) { kfUpdate(st, H2, z, ctx.R[i]); st.x[1] = clampQ(st.x[1]); }
          return { q: st.x[1], sd: Math.sqrt(st.P[1][1]) };
        },
      };
    },
  },
  {
    name: 'Kalman, constant acceleration', family: 'Kalman', grid: [1e-6, 3e-6, 1e-5, 3e-5, 1e-4].map((sj) => ({ sj })),
    make: (p) => (ctx) => {
      const s0 = lltInit(ctx);
      const st = { x: [...s0.x, 0], P: [[s0.P[0][0], 0, 0], [0, s0.P[1][1], 0], [0, 0, 0.01]], t: s0.t };
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) { kfPredict(st, Fca(dt), Qca(p.sj, dt)); st.t = T; }
          if (ok) { kfUpdate(st, H3, z, ctx.R[i]); st.x[1] = clampQ(st.x[1]); }
          return { q: st.x[1], sd: Math.sqrt(st.P[1][1]) };
        },
      };
    },
  },
  {
    name: 'IMM (steady + changing)', family: 'Kalman',
    grid: [70, 85, 100].flatMap((lo) => [100, 150, 250].flatMap((hi) => [0.001, 0.003, 0.01].map((sw) => ({ lo, hi, sw })))),
    make: (p) => (ctx) => {
      const Ss = [rateVarToS(p.lo), rateVarToS(p.hi)];
      let sts = [lltInit(ctx), lltInit(ctx)], mu = [0.8, 0.2], t = ctx.init.T;
      let out = { q: ctx.init.rate, sd: 1 };
      return {
        step(i, T, z, ok) {
          const dt = T - t;
          if (!(dt > 0) && !ok) return out;
          const ps = 1 - Math.exp(-p.sw * Math.max(dt, 0));
          const Pi = [[1 - ps, ps], [ps, 1 - ps]];
          const c = [Pi[0][0] * mu[0] + Pi[1][0] * mu[1], Pi[0][1] * mu[0] + Pi[1][1] * mu[1]];
          const next = [0, 1].map((j) => {
            const w = [(Pi[0][j] * mu[0]) / c[j], (Pi[1][j] * mu[1]) / c[j]];
            const x = [w[0] * sts[0].x[0] + w[1] * sts[1].x[0], w[0] * sts[0].x[1] + w[1] * sts[1].x[1]];
            const P = zeros(2, 2);
            for (const k of [0, 1]) {
              const d = [sts[k].x[0] - x[0], sts[k].x[1] - x[1]];
              for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) P[a][b] += w[k] * (sts[k].P[a][b] + d[a] * d[b]);
            }
            return { x, P, t };
          });
          const L = [1, 1];
          next.forEach((st, j) => {
            if (dt > 0) kfPredict(st, Fllt(dt), Qllt(Ss[j], dt));
            if (ok) {
              const { nu, S } = kfUpdate(st, H2, z, ctx.R[i]);
              L[j] = Math.exp((-0.5 * nu * nu) / S) / Math.sqrt(S);
              st.x[1] = clampQ(st.x[1]);
            }
          });
          sts = next;
          const tot = c[0] * L[0] + c[1] * L[1];
          mu = tot > 0 ? [(c[0] * L[0]) / tot, (c[1] * L[1]) / tot] : c;
          t = T;
          const q = mu[0] * sts[0].x[1] + mu[1] * sts[1].x[1];
          const v = mu[0] * (sts[0].P[1][1] + (sts[0].x[1] - q) ** 2) + mu[1] * (sts[1].P[1][1] + (sts[1].x[1] - q) ** 2);
          out = { q: clampQ(q), sd: Math.sqrt(v) };
          return out;
        },
      };
    },
  },
  {
    name: 'Kalman, self-adjusting (innovation bias)', family: 'Kalman',
    grid: [70, 85, 100].flatMap((rv) => [2, 5, 10, 20].map((c) => ({ rv, c }))),
    make: (p) => (ctx) => {
      const S0 = rateVarToS(p.rv), st = lltInit(ctx);
      let bias = 0;
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) { kfPredict(st, Fllt(dt), Qllt(S0 * (1 + p.c * bias * bias), dt)); st.t = T; }
          if (ok) {
            const { nu, S } = kfUpdate(st, H2, z, ctx.R[i]);
            bias = 0.9 * bias + 0.1 * (nu / Math.sqrt(S));
            st.x[1] = clampQ(st.x[1]);
          }
          return { q: st.x[1], sd: Math.sqrt(st.P[1][1]) };
        },
      };
    },
  },
  {
    name: 'Kalman, Student-t (outlier-tolerant)', family: 'Kalman',
    grid: [70, 100, 150].flatMap((rv) => [3, 6, 12, 30].map((dof) => ({ rv, dof }))),
    make: (p) => (ctx) => {
      const S = rateVarToS(p.rv), st = lltInit(ctx);
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) { kfPredict(st, Fllt(dt), Qllt(S, dt)); st.t = T; }
          if (ok) {
            const R = ctx.R[i], Sp = st.P[0][0] + R, nu = z - st.x[0];
            const w = (p.dof + 1) / (p.dof + (nu * nu) / Sp);
            kfUpdate(st, H2, z, R / w);
            st.x[1] = clampQ(st.x[1]);
          }
          return { q: st.x[1], sd: Math.sqrt(st.P[1][1]) };
        },
      };
    },
  },
  {
    name: 'H-infinity (minimax)', family: 'Kalman',
    grid: [50, 70, 100].flatMap((rv) => [0.003, 0.01, 0.02].map((th) => ({ rv, th }))),
    make: (p) => (ctx) => {
      const S = rateVarToS(p.rv), st = lltInit(ctx);
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) { kfPredict(st, Fllt(dt), Qllt(S, dt)); st.t = T; }
          if (ok) {
            // M = I - th*Sbar*P + H'R^-1 H P, Sbar = diag(0, 1): we care about the rate
            const R = ctx.R[i], P = st.P;
            const M = [[1 + P[0][0] / R, P[0][1] / R], [-p.th * P[1][0], 1 - p.th * P[1][1]]];
            const det = M[0][0] * M[1][1] - M[0][1] * M[1][0];
            if (det > 1e-9 && 1 - p.th * P[1][1] > 0) {
              const Mi = [[M[1][1] / det, -M[0][1] / det], [-M[1][0] / det, M[0][0] / det]];
              const PM = [[P[0][0] * Mi[0][0] + P[0][1] * Mi[1][0], P[0][0] * Mi[0][1] + P[0][1] * Mi[1][1]],
                [P[1][0] * Mi[0][0] + P[1][1] * Mi[1][0], P[1][0] * Mi[0][1] + P[1][1] * Mi[1][1]]];
              const nu = z - st.x[0];
              st.x[0] += (PM[0][0] / R) * nu; st.x[1] += (PM[1][0] / R) * nu;
              st.P = [[PM[0][0], (PM[0][1] + PM[1][0]) / 2], [(PM[0][1] + PM[1][0]) / 2, PM[1][1]]];
            } else kfUpdate(st, H2, z, R);
            st.x[1] = clampQ(st.x[1]);
          }
          return { q: st.x[1], sd: Math.sqrt(Math.max(0, st.P[1][1])) };
        },
      };
    },
  },
  {
    name: 'Particle filter (300, heavy-tailed)', family: 'Kalman',
    grid: [150, 220, 330].flatMap((rv) => [0.003, 0.01, 0.03, 0.1].map((eps) => ({ rv, eps }))),
    make: (p) => (ctx) => {
      const N = 300, S = rateVarToS(p.rv), rnd = mulberry32(ctx.seed * 7 + 1);
      const r0 = ctx.init.Pmm, sq0 = Math.sqrt(ctx.init.Pqq);
      let m = new Float64Array(N), q = new Float64Array(N), w = new Float64Array(N).fill(1 / N);
      // particles only at possible rates (a wild start spreads them over the whole range)
      for (let k = 0; k < N; k++) {
        m[k] = ctx.init.level + Math.sqrt(r0) * gauss(rnd);
        q[k] = sq0 > QMAX / 4 ? rnd() * QMAX : clampQ(ctx.init.rate + sq0 * gauss(rnd));
      }
      let t = ctx.init.T;
      const est = () => {
        let mq = 0; for (let k = 0; k < N; k++) mq += w[k] * q[k];
        let v = 0; for (let k = 0; k < N; k++) v += w[k] * (q[k] - mq) ** 2;
        return { q: clampQ(mq), sd: Math.sqrt(v) };
      };
      return {
        step(i, T, z, ok) {
          const dt = T - t;
          if (dt > 0) {
            const l11 = Math.sqrt((S * dt ** 3) / 3), l21 = (S * dt ** 2) / 2 / l11, l22 = Math.sqrt(Math.max(0, S * dt - l21 * l21));
            for (let k = 0; k < N; k++) { const g1 = gauss(rnd), g2 = gauss(rnd); m[k] += q[k] * dt + l11 * g1; q[k] += l21 * g1 + l22 * g2; }
            t = T;
          }
          if (ok) {
            const R = ctx.R[i];
            let sw = 0;
            for (let k = 0; k < N; k++) {
              const d = z - m[k];
              w[k] *= (1 - p.eps) * Math.exp((-0.5 * d * d) / R) / Math.sqrt(2 * Math.PI * R) + p.eps / 20000;
              sw += w[k];
            }
            if (!(sw > 0)) w.fill(1 / N); else for (let k = 0; k < N; k++) w[k] /= sw;
            let ess = 0; for (let k = 0; k < N; k++) ess += w[k] * w[k];
            if (1 / ess < N / 2) {
              const m2 = new Float64Array(N), q2 = new Float64Array(N);
              let u = rnd() / N, c = w[0], j = 0;
              for (let k = 0; k < N; k++) {
                while (u > c && j < N - 1) { j++; c += w[j]; }
                m2[k] = m[j]; q2[k] = q[j]; u += 1 / N;
              }
              m = m2; q = q2; w.fill(1 / N);
            }
          }
          return est();
        },
      };
    },
  },
  {
    name: 'Alpha-beta (critically damped)', family: 'Exponential smoothing',
    grid: [0.03, 0.05, 0.065, 0.08, 0.1, 0.12].map((a) => ({ a })),
    make: (p) => (ctx) => {
      const a = p.a, b = (a * a) / (2 - a);
      let m = ctx.init.level, q = ctx.init.rate, t = ctx.init.T, tu = ctx.init.T;
      return {
        step(i, T, z, ok) {
          m += q * (T - t); t = T;
          if (ok) {
            const nu = z - m, dt = Math.max(0.2, T - tu);
            m += a * nu; q = clampQ(q + (b / dt) * nu); tu = T;
          }
          return { q };
        },
      };
    },
  },
  {
    name: 'Holt linear (2 parameters)', family: 'Exponential smoothing',
    grid: [0.03, 0.05, 0.08, 0.12, 0.18].flatMap((al) => [0.02, 0.03, 0.04, 0.06].map((be) => ({ al, be }))),
    make: (p) => (ctx) => {
      let l = ctx.init.level, b = ctx.init.rate, tu = ctx.init.T;
      return {
        step(i, T, z, ok) {
          if (ok) {
            const dt = Math.max(0.2, T - tu);
            const ln = p.al * z + (1 - p.al) * (l + b * dt);
            b = clampQ(p.be * ((ln - l) / dt) + (1 - p.be) * b);
            l = ln; tu = T;
          }
          return { q: b };
        },
      };
    },
  },
  {
    name: 'Discounted least squares (Brown)', family: 'Exponential smoothing',
    grid: [8, 10, 12, 15, 18, 25].map((tau) => ({ tau })),
    make: (p) => (ctx) => {
      let S0 = 0, S1 = 0, S2 = 0, Sz = 0, Stz = 0, Tr = ctx.init.T, q = ctx.init.rate;
      return {
        step(i, T, z, ok) {
          const d = T - Tr, e = Math.exp(-d / p.tau);
          const s0 = S0, s1 = S1, sz = Sz;
          S0 = s0 * e; S1 = (s1 - d * s0) * e; S2 = (S2 - 2 * d * s1 + d * d * s0) * e; Sz = sz * e; Stz = (Stz - d * sz) * e;
          Tr = T;
          if (ok) { S0 += 1; Sz += z; }
          const den = S0 * S2 - S1 * S1;
          if (S0 >= 4 && den > 1e-9) q = clampQ((S0 * Stz - S1 * Sz) / den);
          return { q };
        },
      };
    },
  },
  {
    name: 'Smoothed differences (naive)', family: 'Exponential smoothing',
    grid: [0.003, 0.005, 0.01, 0.02].map((a) => ({ a })),
    make: (p) => (ctx) => {
      let zp = null, tp = null, q = ctx.init.rate;
      return {
        step(i, T, z, ok) {
          if (ok) {
            if (zp != null && T > tp) q = (1 - p.a) * q + p.a * ((z - zp) / (T - tp));
            zp = z; tp = T;
          }
          return { q: clampQ(q) };
        },
      };
    },
  },
  {
    name: 'Least-squares slope, sliding window', family: 'Window regression',
    grid: [20, 30, 40, 50, 60].map((W) => ({ W })),
    make: (p) => windowed(p.W, (t, z, T) => olsSlope(t, z, T)),
  },
  {
    name: 'Theil-Sen slope, sliding window', family: 'Window regression',
    grid: [20, 30, 40, 60].map((W) => ({ W })),
    make: (p) => windowed(p.W, (t, z) => robustSlope(t, z, 0, t.length)?.slope ?? null),
  },
  {
    name: 'Savitzky-Golay (quadratic, causal)', family: 'Window regression',
    grid: [60, 90, 120, 150].map((W) => ({ W })),
    make: (p) => windowed(p.W, (t, z, T, W) => wlsSlopeAtEnd(t, z, T, W, 2, () => 1)),
  },
  {
    name: 'LOESS (tricube, causal)', family: 'Window regression',
    grid: [30, 45, 60, 75].map((W) => ({ W })),
    make: (p) => windowed(p.W, (t, z, T, W) => wlsSlopeAtEnd(t, z, T, W, 1, (u) => { const a = Math.abs(u); return a < 1 ? (1 - a ** 3) ** 3 : 0; })),
  },
  {
    name: 'Step timing (level crossings)', family: 'Specialised',
    grid: [45, 60, 90, 120].map((W) => ({ W })),
    make: (p) => (ctx) => {
      // the displayed level moves in 50 kg steps: rate = kg per second between the
      // times it stepped up (a new level counts once seen in two readings)
      let L = Math.round(ctx.init.level / 50) * 50, pend = null, q = ctx.init.rate;
      const tr = [{ t: ctx.init.T, L }];
      return {
        step(i, T, z, ok) {
          if (ok) {
            const zz = Math.round(z / 50) * 50;
            if (zz >= L + 50) {
              if (pend && Math.abs(pend.L - zz) <= 50) { tr.push({ t: pend.t, L: zz }); L = zz; pend = null; } else pend = { t: T, L: zz };
            } else pend = null;
          }
          while (tr.length > 2 && tr[1].t < T - p.W) tr.shift();
          const pts = tr.filter((x) => x.t >= T - p.W);
          if (pts.length >= 3) {
            const s = olsSlope(pts.map((x) => x.t), pts.map((x) => x.L), T);
            if (s != null) q = clampQ(s);
          }
          const last = tr[tr.length - 1];
          if (T - last.t > 1) q = Math.min(q, 75 / (T - last.t)); // no step for a while: slower
          return { q };
        },
      };
    },
  },
  {
    name: 'Fixed-lag smoother (shown late)', family: 'Specialised',
    grid: [55, 70, 85, 100].flatMap((rv) => [1, 2, 3, 6, 10].map((lag) => ({ lag, rv }))),
    make: (p) => (ctx) => {
      const S = rateVarToS(p.rv), st = lltInit(ctx);
      const hist = []; // {t, xp, Pp, xf, Pf}
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) { kfPredict(st, Fllt(dt), Qllt(S, dt)); st.t = T; }
          const xp = [...st.x], Pp = st.P.map((r) => [...r]);
          if (ok) { kfUpdate(st, H2, z, ctx.R[i]); st.x[1] = clampQ(st.x[1]); }
          hist.push({ t: T, xp, Pp, xf: [...st.x], Pf: st.P.map((r) => [...r]) });
          while (hist.length > 2 && hist[1].t < T - p.lag) hist.shift();
          // RTS back to the oldest kept reading (about lag seconds ago)
          let xs = hist[hist.length - 1].xf;
          for (let k = hist.length - 2; k >= 0; k--) {
            const f = hist[k], nx = hist[k + 1], d = nx.t - f.t;
            const A = [[f.Pf[0][0] + f.Pf[0][1] * d, f.Pf[0][1]], [f.Pf[1][0] + f.Pf[1][1] * d, f.Pf[1][1]]];
            const pa = nx.Pp[0][0], pb = nx.Pp[0][1], pc = nx.Pp[1][1], det = pa * pc - pb * pb;
            const C10 = (A[1][0] * pc - A[1][1] * pb) / det, C11 = (A[1][1] * pa - A[1][0] * pb) / det;
            const C00 = (A[0][0] * pc - A[0][1] * pb) / det, C01 = (A[0][1] * pa - A[0][0] * pb) / det;
            const dm = xs[0] - nx.xp[0], dq = xs[1] - nx.xp[1];
            xs = [f.xf[0] + C00 * dm + C01 * dq, f.xf[1] + C10 * dm + C11 * dq];
          }
          return { q: clampQ(xs[1]) };
        },
      };
    },
  },
  {
    // a bank of filters, each assuming a different swing period (plus one assuming no
    // swing), weighted by how well each has predicted the recent readings
    name: 'Kalman + load-swing model (period learned)', family: 'Kalman',
    grid: [10, 20, 35].flatMap((sig) => [70, 100, 150].map((rv) => ({ sig, rv }))),
    make: (p) => (ctx) => {
      const S = rateVarToS(p.rv), zeta = 0.05, lam = 0.98, s0 = lltInit(ctx);
      const periods = [null];
      for (let P = 2.5; P <= 7.001; P += 0.25) periods.push(P);
      const bank = periods.map((P) => ({
        P, lw: 0,
        st: P == null ? { x: [...s0.x], P: s0.P.map((r) => [...r]) }
          : { x: [...s0.x, 0, 0], P: blockDiag(s0.P, [[p.sig ** 2, 0], [0, ((2 * Math.PI) / P) ** 2 * p.sig ** 2]]) },
      }));
      let t = ctx.init.T, out = { q: ctx.init.rate, sd: Math.sqrt(ctx.init.Pqq) };
      return {
        step(i, T, z, ok) {
          const dt = T - t;
          for (const b of bank) {
            if (dt > 0) {
              if (b.P == null) kfPredict(b.st, Fllt(dt), Qllt(S, dt));
              else { const o = oscModel(b.P, zeta, p.sig, dt); kfPredict(b.st, blockDiag(Fllt(dt), o.F), blockDiag(Qllt(S, dt), o.Q)); }
            }
            if (ok) {
              const { nu, S: Sv } = kfUpdate(b.st, b.P == null ? H2 : H4, z, ctx.R[i]);
              b.lw = lam * b.lw - 0.5 * ((nu * nu) / Sv + Math.log(Sv));
              b.st.x[1] = clampQ(b.st.x[1]);
            }
          }
          if (dt > 0) t = T;
          const top = Math.max(...bank.map((b) => b.lw));
          let sw = 0, q = 0;
          for (const b of bank) { b.w = Math.exp(b.lw - top); sw += b.w; }
          for (const b of bank) q += (b.w / sw) * b.st.x[1];
          let v = 0;
          for (const b of bank) v += (b.w / sw) * (b.st.P[1][1] + (b.st.x[1] - q) ** 2);
          out = { q: clampQ(q), sd: Math.sqrt(v) };
          return out;
        },
      };
    },
  },
  {
    name: 'Blend: shipped Kalman + window least squares', family: 'Specialised',
    grid: [0.05, 0.1, 0.15, 0.3].flatMap((w) => [30, 45, 60].map((W) => ({ w, W }))),
    make: (p) => (ctx) => {
      const win = windowed(p.W, (t, z, T) => olsSlope(t, z, T))(ctx);
      return {
        step(i, T, z, ok) {
          const a = win.step(i, T, z, ok).q;
          return { q: (1 - p.w) * ctx.stream[i].qEng + p.w * a };
        },
      };
    },
  },
];

// ----------------------------------------------------------- references --
// Not real candidates: they cheat by knowing things only the simulator knows, to show
// how much room for improvement there is at all.
export const REFERENCES = [
  {
    // the Kalman filter fed readings with the load swing removed
    name: 'Reference: Kalman, swing removed (cheat)', family: 'Reference', reference: true,
    grid: [70, 100, 150].map((rv) => ({ rv })),
    make: (p) => (ctx) => {
      const S = rateVarToS(p.rv), st = lltInit(ctx);
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) { kfPredict(st, Fllt(dt), Qllt(S, dt)); st.t = T; }
          if (ok) { kfUpdate(st, H2, z - ctx.sim.swing(T), ctx.R[i]); st.x[1] = clampQ(st.x[1]); }
          return { q: st.x[1], sd: Math.sqrt(st.P[1][1]) };
        },
      };
    },
  },
  {
    // knows the tap's planned rate curve, the size and pace of its wander, the swing and
    // the true mass at the start: only the wander's current value is unknown
    name: 'Reference: knows the true tap model (cheat)', family: 'Reference', reference: true, grid: [{}],
    make: () => (ctx) => {
      const sim = ctx.sim, o = sim.o, tS = sim.tapStart;
      const plan = sim.profile ?? ((tt) => o.rateEnd + (o.rate0 - o.rateEnd) * Math.exp(-tt / o.rateTau));
      const sw2 = (o.wander / 60) ** 2, tau = o.wanderTau, T0 = ctx.init.T;
      const st = { x: [sim.trueMass(T0), 0], P: [[100, 0], [0, sw2]], t: T0 };
      const planned = (t) => { const tt = t - tS; return tt <= 0 ? 0 : (plan(tt) * Math.min(1, tt / 3)) / 60; };
      return {
        step(i, T, z, ok) {
          const dt = T - st.t;
          if (dt > 0) {
            const f = Math.exp(-dt / tau), a = tau * (1 - f);
            const Q = [[sw2 * tau * tau * ((2 * dt) / tau - 3 + 4 * f - f * f), sw2 * tau * (1 - f) ** 2], [sw2 * tau * (1 - f) ** 2, sw2 * (1 - f * f)]];
            kfPredict(st, [[1, a], [0, f]], Q);
            for (let k = 0; k < 5; k++) st.x[0] += (planned(st.t + ((k + 0.5) * dt) / 5) * dt) / 5;
            st.t = T;
          }
          if (ok) kfUpdate(st, H2, z - sim.swing(T), ctx.R[i]);
          return { q: clampQ(planned(T) + st.x[1]), sd: Math.sqrt(st.P[1][1]) };
        },
      };
    },
  },
];
