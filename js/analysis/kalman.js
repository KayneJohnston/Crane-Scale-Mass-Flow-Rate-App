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
