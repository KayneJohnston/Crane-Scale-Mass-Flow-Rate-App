// Probability of every value the display can show (1,000, 1,050, ... 40,000 kg), given
// the frames and the prediction, by Bayes' rule:
//
//   P(value | frames)  ∝  P(frames | value)  x  P(value)
//                         the picture           dead reckoning
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
// The frames before: the display holds a value for seconds between updates, so right
// after a clear reading of X it most likely still shows X - unless it changed since,
// with probability q (from how often the readings changed lately; tracker.js). The
// prior is then X with probability 1 - q, otherwise as below. Only clear readings are
// carried over like this: the frames of an unclear spell share their faults - the same
// glow fools them alike - so multiplying their pictures together compounds one
// mistake into certainty. (Tried as a Bayes filter over all frames: in simulated taps
// it doubled the wrong values.)
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

// the values the display can show
const grids = new Map();
function gridOf(c) {
  const mult = c.multiplier || 1, step = c.stepKg || 50;
  const key = `${c.minKg}/${c.maxKg}/${step}/${mult}`;
  let g = grids.get(key);
  if (!g) {
    const vals = [], ds = [];
    for (let v = Math.ceil(c.minKg / step) * step; v <= c.maxKg; v += step) { vals.push(v); ds.push(String(Math.round(v / mult))); }
    g = { vals, ds, step, n: vals.length };
    grids.set(key, g);
  }
  return g;
}

/** P(frame | value) for every value of the grid, scaled to a maximum of 1. */
function pictureLikelihood(lattice, grid, c) {
  const { costs, n } = lattice;
  const T = c.imageTemp;
  const minc = costs.map((row) => Math.min(...row));
  const best = minc.reduce((a, b) => a + b, 0);
  const L = new Float64Array(grid.n);
  let mx = 0;
  for (let i = 0; i < grid.n; i++) {
    const ds = grid.ds[i], m = ds.length;
    let l = 0;
    if (m === n) l = (1 - c.slipProb) * Math.exp(-(costOf(costs, ds) - best) / T);
    else if (m === n + 1) {
      // a digit lost: the glyphs show the value without one of its digits
      for (let k = 0; k < m; k++) l += Math.exp(-(costOf(costs, ds.slice(0, k) + ds.slice(k + 1)) - best) / T);
      l *= c.slipProb / 2 / m;
    } else if (m === n - 1) {
      // a glyph too many: one of them is no digit of the value (it fits whatever it fits best)
      for (let k = 0; k < n; k++) {
        let cost = minc[k];
        for (let j = 0; j < m; j++) cost += costs[j < k ? j : j + 1][ds.charCodeAt(j) - 48];
        l += Math.exp(-(cost - best) / T);
      }
      l *= c.slipProb / 2 / n;
    }
    L[i] = l;
    if (l > mx) mx = l;
  }
  if (mx > 0) for (let i = 0; i < grid.n; i++) L[i] /= mx;
  return L;
}

// the dead-reckoning prior over the grid (uniform without a prediction); hold {v, q}:
// the display still shows v, unless it changed (probability q)
function priorOf(grid, pred, c, hold = null) {
  const N = grid.n, prior = new Float64Array(N);
  if (!pred) prior.fill(1 / N);
  else bandPrior(prior, grid, pred, c);
  const k = hold ? grid.vals.indexOf(hold.v) : -1;
  if (k >= 0) {
    for (let i = 0; i < N; i++) prior[i] *= hold.q;
    prior[k] += 1 - hold.q;
  }
  return prior;
}

function bandPrior(prior, grid, pred, c) {
  const N = grid.n;
  const a = pred.value - pred.band, b = pred.value + pred.band, step = grid.step;
  let sIn = 0, sTouch = 0;
  const fIn = new Float64Array(N), fTouch = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const v = grid.vals[i], d = v < a ? (a - v) / step : v > b ? (v - b) / step : 0;
    fIn[i] = Math.exp(-0.5 * d * d);
    fTouch[i] = v < a && v >= a - c.touchKg ? 1 : 0;
    sIn += fIn[i]; sTouch += fTouch[i];
  }
  const wIn = 1 - c.priorTouch - c.priorOutside;
  for (let i = 0; i < N; i++) prior[i] = wIn * fIn[i] / sIn + (sTouch ? c.priorTouch * fTouch[i] / sTouch : 0) + c.priorOutside / N;
}

// the most probable value, and how well this frame's own glyphs fit it
function summarize(lik, prior, grid, lattice, held) {
  const N = grid.n, post = new Float64Array(N);
  let z = 0, bi = 0;
  for (let i = 0; i < N; i++) {
    post[i] = lik[i] * prior[i];
    z += post[i];
    if (post[i] > post[bi]) bi = i;
  }
  if (!(z > 0)) return null;
  const order = [...post.keys()].sort((x, y) => post[y] - post[x]).slice(0, 3);
  const ds = grid.ds[bi], { costs, n } = lattice;
  const sameLength = ds.length === n;
  let excess = Infinity, mx = Infinity;
  if (sameLength) {
    excess = costOf(costs, ds) - costs.reduce((a, row) => a + Math.min(...row), 0);
    mx = 0;
    for (let i = 0; i < n; i++) mx = Math.max(mx, costs[i][ds.charCodeAt(i) - 48]);
  }
  return { v: grid.vals[bi], p: post[bi] / z, excess, maxDigitCost: mx, sameLength, held, top: order.map((i) => ({ v: grid.vals[i], p: post[i] / z })) };
}

/**
 * One frame: lattice {n, costs}; pred {value, band} or null (picture only); cfg: minKg,
 * maxKg, stepKg, multiplier and POSTERIOR_DEFAULTS; hold {v, q} or null: v was read
 * clearly a moment ago, and the display has changed since with probability q.
 * Returns {v, p, excess, maxDigitCost, sameLength, held, top: [{v, p}, ...]} for the
 * most probable value (excess: how much worse its digits fit than the frame's best
 * reading), or null without a lattice.
 */
export function valuePosterior(lattice, pred, cfg, hold = null) {
  if (!lattice || !lattice.n) return null;
  const c = { ...POSTERIOR_DEFAULTS, ...cfg };
  const grid = gridOf(c);
  return summarize(pictureLikelihood(lattice, grid, c), priorOf(grid, pred, c, hold), grid, lattice, !!hold);
}
