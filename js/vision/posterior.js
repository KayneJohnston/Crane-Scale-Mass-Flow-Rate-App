// Probability of every value the display can show (1,000, 1,050, ... 40,000 kg), given
// one frame and the prediction, by Bayes' rule:
//
//   P(value | frame)  ∝  P(frame | value)  x  P(value)
//                        the picture          dead reckoning
//
// The picture: the reader reports how badly each glyph fits each digit 0-9 (its
// "lattice": ~0.3 for a clean match, ~1 per segment that differs). A value's cost is
// the sum over its digits, and P(frame | value) = exp(-cost / imageTemp): each segment
// that does not fit makes a value about 50 times less likely. imageTemp was fitted on
// 3,500 unclear readings with known values (tools/lattice-calib.mjs) so that these
// probabilities come out right on average; a stated 90-95% was right 96% of the time.
// The reader may also have lost a digit (17000 seen as four glyphs) or taken a dash or
// an LED for one: values with one digit more or fewer than the glyphs keep a small
// chance (slipProb).
//
// Dead reckoning: the prediction (the last readings and the tap rate) puts the value
// in its band - flat over the band, falling off over a display step or so outside it.
// A touch the camera did not see may have pulled the reading down meanwhile
// (priorTouch, spread over touchKg below the band), and anything else may have
// happened (priorOutside, spread over every value).

export const POSTERIOR_DEFAULTS = {
  imageTemp: 0.26,
  slipProb: 0.02,
  priorTouch: 0.03,
  priorOutside: 0.005,
  touchKg: 2000,
};

const costOf = (costs, ds) => {
  let c = 0;
  for (let i = 0; i < ds.length; i++) c += costs[i][ds.charCodeAt(i) - 48];
  return c;
};

/**
 * lattice {n, costs}; pred {value, band} or null (picture only); cfg: minKg, maxKg,
 * stepKg, multiplier and POSTERIOR_DEFAULTS.
 * Returns {v, p, excess, maxDigitCost, sameLength, top: [{v, p}, ...]} for the most
 * probable value (excess: how much worse its digits fit than the frame's best reading),
 * or null without a lattice.
 */
export function valuePosterior(lattice, pred, cfg) {
  if (!lattice || !lattice.n) return null;
  const c = { ...POSTERIOR_DEFAULTS, ...cfg };
  const { costs, n } = lattice;
  const mult = c.multiplier || 1, step = c.stepKg || 50, T = c.imageTemp;
  const minc = costs.map((row) => Math.min(...row));
  const best = minc.reduce((a, b) => a + b, 0);
  const vals = [], lik = [];
  for (let v = Math.ceil(c.minKg / step) * step; v <= c.maxKg; v += step) {
    const ds = String(Math.round(v / mult));
    const m = ds.length;
    let L = 0;
    if (m === n) L = (1 - c.slipProb) * Math.exp(-(costOf(costs, ds) - best) / T);
    else if (m === n + 1) {
      // a digit lost: the glyphs show the value without one of its digits
      for (let k = 0; k < m; k++) L += Math.exp(-(costOf(costs, ds.slice(0, k) + ds.slice(k + 1)) - best) / T);
      L *= c.slipProb / 2 / m;
    } else if (m === n - 1) {
      // a glyph too many: one of them is no digit of the value (it fits whatever it fits best)
      for (let k = 0; k < n; k++) {
        let cost = minc[k];
        for (let i = 0; i < m; i++) cost += costs[i < k ? i : i + 1][ds.charCodeAt(i) - 48];
        L += Math.exp(-(cost - best) / T);
      }
      L *= c.slipProb / 2 / n;
    } else continue;
    vals.push(v); lik.push(L);
  }
  const N = vals.length;
  if (!N) return null;
  // the prior
  const prior = new Float64Array(N);
  if (!pred) prior.fill(1 / N);
  else {
    const a = pred.value - pred.band, b = pred.value + pred.band;
    let sIn = 0, sTouch = 0;
    const fIn = new Float64Array(N), fTouch = new Float64Array(N);
    for (let i = 0; i < N; i++) {
      const v = vals[i], d = v < a ? (a - v) / step : v > b ? (v - b) / step : 0;
      fIn[i] = Math.exp(-0.5 * d * d);
      fTouch[i] = v < a && v >= a - c.touchKg ? 1 : 0;
      sIn += fIn[i]; sTouch += fTouch[i];
    }
    const wIn = 1 - c.priorTouch - c.priorOutside;
    for (let i = 0; i < N; i++) {
      prior[i] = wIn * fIn[i] / sIn + (sTouch ? c.priorTouch * fTouch[i] / sTouch : 0) + c.priorOutside / N;
    }
  }
  let z = 0, bi = 0;
  const post = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    post[i] = lik[i] * prior[i];
    z += post[i];
    if (post[i] > post[bi]) bi = i;
  }
  if (!(z > 0)) return null;
  const order = [...post.keys()].sort((x, y) => post[y] - post[x]).slice(0, 3);
  const v = vals[bi], ds = String(Math.round(v / mult));
  const sameLength = ds.length === n;
  let excess = Infinity, mx = Infinity;
  if (sameLength) {
    excess = costOf(costs, ds) - best;
    mx = 0;
    for (let i = 0; i < n; i++) mx = Math.max(mx, costs[i][ds.charCodeAt(i) - 48]);
  }
  return { v, p: post[bi] / z, excess, maxDigitCost: mx, sameLength, top: order.map((i) => ({ v: vals[i], p: post[i] / z })) };
}
