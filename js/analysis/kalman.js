// Constant-rate ("local linear trend") Kalman filter for crucible mass.
//
// State x = [m, q]: m = mass in the crucible (kg), q = tap rate (kg/s).
//   m(t+dt) = m(t) + q(t) dt
//   q(t+dt) = q(t) + w,   w ~ white noise with spectral density S  ((kg/s)^2 / s)
//   z       = m + v,      v ~ N(0, R)   (scale noise + 50 kg quantisation)
//
// With white noise on the rate this is the "integrated random walk" trend
// model, whose Kalman filter is the real-time (causal) form of a cubic
// smoothing spline fitted to the weight curve; the rate estimate is the
// slope of that spline. S sets how quickly the true tap rate is allowed to
// change; R is estimated from the data.

export class RateKF {
  constructor(S) {
    this.S = S;
    this.t = null;
    this.m = 0; this.q = 0;
    this.Pmm = 1e6; this.Pmq = 0; this.Pqq = 1;
  }

  init(t, m, q, Pmm, Pqq, Pmq = 0) {
    this.t = t; this.m = m; this.q = q;
    this.Pmm = Pmm; this.Pqq = Pqq; this.Pmq = Pmq;
  }

  predict(t) {
    const dt = t - this.t;
    if (!(dt > 0)) return;
    const S = this.S, a = this.Pmm, b = this.Pmq, c = this.Pqq;
    this.m += this.q * dt;
    this.Pmm = a + 2 * b * dt + c * dt * dt + (S * dt * dt * dt) / 3;
    this.Pmq = b + c * dt + (S * dt * dt) / 2;
    this.Pqq = c + S * dt;
    this.t = t;
  }

  /** Measurement update with variance R. Returns the innovation. */
  update(z, R) {
    const a = this.Pmm, b = this.Pmq, c = this.Pqq;
    const s = a + R;
    const k1 = a / s, k2 = b / s;
    const nu = z - this.m;
    this.m += k1 * nu;
    this.q += k2 * nu;
    this.Pmm = a - (a * a) / s;
    this.Pmq = b - (a * b) / s;
    this.Pqq = c - (b * b) / s;
    return nu;
  }

  /** State predicted at time t without changing the filter. */
  peek(t) {
    const dt = Math.max(0, t - this.t);
    return {
      m: this.m + this.q * dt,
      q: this.q,
      Pmm: this.Pmm + 2 * this.Pmq * dt + this.Pqq * dt * dt + (this.S * dt ** 3) / 3,
      Pqq: this.Pqq + this.S * dt,
    };
  }
}

/** Rate-variability setting (kg/min of drift per minute, 1 sigma) -> spectral density S. */
export function rateVarToS(kgMinPerMin) {
  const dq = kgMinPerMin / 60; // kg/s change over 60 s
  return (dq * dq) / 60;
}

/**
 * Two-pass (Rauch–Tung–Striebel) smoother for the same model: the filter is run
 * forward over the readings, then backward, so every estimate also uses the
 * readings after it. Each reading's rate is then known from both sides, without
 * the lag a live filter must have. ts/zs: times (s) and readings (kg), rs: their
 * variances (kg^2); x0: {t, m, q, Pmm, Pqq} before the first reading.
 * Returns [{m, q, sdq}] per reading (q and sdq in kg/s).
 */
export function smoothRate(S, ts, zs, rs, x0) {
  const n = ts.length;
  const kf = new RateKF(S);
  kf.init(x0.t, x0.m, x0.q, x0.Pmm, x0.Pqq, x0.Pmq ?? 0);
  // per reading: the prediction before it and the estimate after it (m, q, Pmm, Pmq, Pqq)
  const pr = new Float64Array(5 * n), fi = new Float64Array(5 * n);
  for (let i = 0; i < n; i++) {
    kf.predict(ts[i]);
    pr.set([kf.m, kf.q, kf.Pmm, kf.Pmq, kf.Pqq], 5 * i);
    kf.update(zs[i], rs[i]);
    fi.set([kf.m, kf.q, kf.Pmm, kf.Pmq, kf.Pqq], 5 * i);
  }
  const out = new Array(n);
  if (!n) return out;
  let [m, q, a, b, c] = fi.subarray(5 * (n - 1));
  out[n - 1] = { m, q, sdq: Math.sqrt(c) };
  for (let i = n - 2; i >= 0; i--) {
    const f = 5 * i, p = 5 * (i + 1), dt = ts[i + 1] - ts[i];
    const fa = fi[f + 2], fb = fi[f + 3], fc = fi[f + 4];
    const pa = pr[p + 2], pb = pr[p + 3], pc = pr[p + 4];
    // gain C = P_i F' P_pred^-1, with F = [[1, dt], [0, 1]]
    const det = pa * pc - pb * pb;
    const A00 = fa + fb * dt, A01 = fb, A10 = fb + fc * dt, A11 = fc;
    const C00 = (A00 * pc - A01 * pb) / det, C01 = (A01 * pa - A00 * pb) / det;
    const C10 = (A10 * pc - A11 * pb) / det, C11 = (A11 * pa - A10 * pb) / det;
    const dm = m - pr[p], dq = q - pr[p + 1];
    m = fi[f] + C00 * dm + C01 * dq;
    q = fi[f + 1] + C10 * dm + C11 * dq;
    // P = P_i + C (P_next - P_pred) C'
    const Da = a - pa, Db = b - pb, Dc = c - pc;
    const X00 = C00 * Da + C01 * Db, X01 = C00 * Db + C01 * Dc;
    const X10 = C10 * Da + C11 * Db, X11 = C10 * Db + C11 * Dc;
    a = fa + X00 * C00 + X01 * C01;
    b = fb + X00 * C10 + X01 * C11;
    c = fc + X10 * C10 + X11 * C11;
    out[i] = { m, q, sdq: Math.sqrt(Math.max(0, c)) };
  }
  return out;
}
