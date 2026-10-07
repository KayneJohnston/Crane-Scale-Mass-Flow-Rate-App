// Seven-segment LED display reader.
//
// Pure functions operating on RGBA pixel buffers (ImageData.data layout), so
// the exact same code runs in the browser and in the Node test-suite.
//
// Pipeline (see README "Computer vision"):
//   1. locateDisplay(): coarse search for a horizontal row of red blobs in a
//      downscaled view of the camera frame.
//   2. readDigits(): on a tight, rescaled crop of that row:
//        redness score -> 3x3 blur -> adaptive threshold (Otsu + floor)
//        -> estimate in-plane rotation (row-projection sharpness)
//        -> estimate italic slant (column-projection sharpness)
//        -> find the digit band -> split into glyphs by column gaps
//        -> measure the fill of the 7 segment regions of each glyph
//        -> nearest template (soft Hamming distance) with a confidence margin.

const SEG = 'abcdefg';

const TEMPLATE_DEFS = [
  ['0', 'abcdef'], ['1', 'bc'], ['2', 'abdeg'], ['3', 'abcdg'], ['4', 'bcfg'],
  ['5', 'acdfg'], ['6', 'acdefg'], ['6', 'cdefg'], ['7', 'abc'], ['7', 'abcf'],
  ['8', 'abcdefg'], ['9', 'abcdfg'], ['9', 'abcfg'],
];
export const TEMPLATES = TEMPLATE_DEFS.map(([ch, segs]) => ({
  ch, segs, v: [...SEG].map((s) => (segs.includes(s) ? 1 : 0)),
}));

// Sampling regions inside a digit cell: [u0, u1, v0, v1], u across, v down (0..1).
// Regions avoid the corners where neighbouring segments meet, so glow from a
// lit neighbour does not leak into an unlit segment's region.
const REGIONS = [
  [0.36, 0.64, 0.00, 0.17], // a
  [0.72, 1.00, 0.20, 0.40], // b
  [0.72, 1.00, 0.60, 0.80], // c
  [0.36, 0.64, 0.83, 1.00], // d
  [0.00, 0.28, 0.60, 0.80], // e
  [0.00, 0.28, 0.20, 0.40], // f
  [0.36, 0.64, 0.42, 0.58], // g
];
const HORIZ = [0, 3, 6];
const VERT = [1, 2, 4, 5];

export const READ_DEFAULTS = {
  colorMode: 'red',   // 'red' | 'bright'
  strictness: 1,      // red score = R - strictness * max(G, B)
  minContrast: 30,
  minLevel: 25,
  relThr: 0.5,        // threshold at 50% between background and segment core (edge of a blurred step)
  hiFrac: 0.004,      // "segment core" level = value exceeded by this fraction of the crop
  minPixels: 40,
  maxPoints: 40000,
  maxRotDeg: 12,
  maxShear: 0.5,
  minDigitH: 8,
  maxCost: 1.7,
  minMargin: 0.6,
  expectDigits: 0,     // digits the display must show (0 = unknown); guides segmentation
  keepMask: false,
};

export const LOCATE_DEFAULTS = {
  colorMode: 'red',
  strictness: 1,
  minContrast: 30,
  minLevel: 25,
  relThr: 0.4,
  hiFrac: 0.0003,     // the display may be a tiny part of the search image
  minH: 3,
  maxCandidates: 3,
  prev: null,          // {cx, cy, h} of the previous detection in this image's coordinates
};

// ---------------------------------------------------------------- basics --

export function scoreImage(rgba, n, mode = 'red', strictness = 1, out) {
  const o = out && out.length >= n ? out : new Uint8ClampedArray(n);
  if (mode === 'bright') {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2];
      o[i] = r > g ? (r > b ? r : b) : (g > b ? g : b);
    }
  } else {
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const g = rgba[p + 1], b = rgba[p + 2];
      const s = rgba[p] - (g > b ? g : b) * strictness;
      o[i] = s > 0 ? s : 0;
    }
  }
  return o;
}

// 3x3 box blur (edge-replicated), Uint8 -> Uint8.
export function blur3(src, w, h) {
  const tmp = new Uint16Array(w * h);
  const out = new Uint8ClampedArray(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const l = x > 0 ? x - 1 : 0, rr = x < w - 1 ? x + 1 : w - 1;
      tmp[r + x] = src[r + l] + src[r + x] + src[r + rr];
    }
  }
  for (let y = 0; y < h; y++) {
    const u = (y > 0 ? y - 1 : 0) * w, c = y * w, d = (y < h - 1 ? y + 1 : h - 1) * w;
    for (let x = 0; x < w; x++) out[c + x] = (tmp[u + x] + tmp[c + x] + tmp[d + x]) / 9;
  }
  return out;
}

export function histQuantile(hist, total, q) {
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 255;
}

// Otsu threshold: pixels with value > returned threshold are foreground.
export function otsu(hist, total) {
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = -1, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function adaptiveThreshold(sm, n, o) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < n; i++) hist[sm[i]]++;
  const p50 = histQuantile(hist, n, 0.5);
  // level reached by the brightest max(8, hiFrac*n) pixels
  const need = Math.max(8, o.hiFrac * n);
  let pHi = 255;
  for (let acc = 0; pHi > 0; pHi--) { acc += hist[pHi]; if (acc >= need) break; }
  const contrast = pHi - p50;
  const T = Math.max(otsu(hist, n), p50 + o.relThr * contrast, o.minLevel);
  return { T, contrast, p50, pHi };
}

// Choose the coefficient c maximising the sum of squared histogram counts of a + c*b
// (i.e. the sharpest projection profile).
function bestProjection(a, b, n, coefs) {
  let A = 0, B = 0;
  for (let i = 0; i < n; i++) {
    const aa = Math.abs(a[i]), bb = Math.abs(b[i]);
    if (aa > A) A = aa; if (bb > B) B = bb;
  }
  let cmax = 0;
  for (const c of coefs) cmax = Math.max(cmax, Math.abs(c));
  const off = Math.ceil(A + cmax * B) + 2;
  const hist = new Int32Array(2 * off + 2);
  let best = -1, bestC = 0;
  for (const c of coefs) {
    hist.fill(0);
    for (let i = 0; i < n; i++) hist[(a[i] + c * b[i] + off + 0.5) | 0]++;
    let s = 0;
    for (let j = 0; j < hist.length; j++) s += hist[j] * hist[j];
    if (s > best + 1e-9) { best = s; bestC = c; }
  }
  return bestC;
}

function range(from, to, step) {
  const out = [];
  for (let v = from; v <= to + 1e-9; v += step) out.push(+v.toFixed(6));
  return out;
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function quantile(arr, q) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const pos = q * (s.length - 1), lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

// --------------------------------------------------------------- stage 2 --

/**
 * Read a row of seven-segment digits from a (tight) crop.
 * Returns {ok, text, digits:[{ch, conf, cost, margin, quad}], conf, digitH, reason, ...}.
 */
export function readDigits(rgba, w, h, opts = {}) {
  const o = { ...READ_DEFAULTS, ...opts };
  const n = w * h;
  const res = {
    ok: false, reason: '', text: '', digits: [], conf: 0, digitH: 0,
    threshold: 0, contrast: 0, rotDeg: 0, shear: 0, bandQuad: null, extras: [],
  };
  const fail = (why) => { res.reason = why; return res; };
  if (w < 8 || h < 8) return fail('tiny');

  const sm = blur3(scoreImage(rgba, n, o.colorMode, o.strictness), w, h);
  const th = adaptiveThreshold(sm, n, o);
  res.threshold = th.T; res.contrast = th.contrast;
  if (o.keepMask) res.mask = { data: sm, w, h, T: th.T };
  if (th.contrast < o.minContrast) return fail('low-contrast');
  const T = th.T;

  let cnt = 0;
  for (let i = 0; i < n; i++) if (sm[i] > T) cnt++;
  if (cnt < o.minPixels) return fail('no-pixels');
  const stride = cnt > o.maxPoints ? Math.ceil(cnt / o.maxPoints) : 1;
  const cap = Math.ceil(cnt / stride);
  const px = new Float32Array(cap), py = new Float32Array(cap);
  let k = 0, c = 0, sx = 0, sy = 0;
  for (let y = 0, i = 0; y < h; y++) {
    for (let x = 0; x < w; x++, i++) {
      if (sm[i] > T) {
        if (c % stride === 0 && k < cap) { px[k] = x; py[k] = y; sx += x; sy += y; k++; }
        c++;
      }
    }
  }
  const cx = sx / k, cy = sy / k;
  for (let i = 0; i < k; i++) { px[i] -= cx; py[i] -= cy; }

  // In-plane rotation: horizontal segments (a, g, d) of all digits line up on three rows.
  const maxTan = Math.tan((o.maxRotDeg * Math.PI) / 180);
  let cr = bestProjection(py, px, k, range(-maxTan, maxTan, Math.tan(Math.PI / 180)));
  cr = bestProjection(py, px, k, range(cr - 0.0131, cr + 0.0131, 0.0044));
  const xr = new Float32Array(k), yr = new Float32Array(k);
  for (let i = 0; i < k; i++) { yr[i] = py[i] + cr * px[i]; xr[i] = px[i] - cr * py[i]; }
  res.rotDeg = (-Math.atan(cr) * 180) / Math.PI;

  // Italic slant: vertical segments line up on columns.
  let sh = bestProjection(xr, yr, k, range(-o.maxShear, o.maxShear, 0.02));
  sh = bestProjection(xr, yr, k, range(sh - 0.02, sh + 0.02, 0.005));
  res.shear = sh;
  const u = new Float32Array(k);
  for (let i = 0; i < k; i++) u[i] = xr[i] + sh * yr[i];
  const v = yr;
  const toOrig = (uu, vv) => {
    const x2 = uu - sh * vv, y2 = vv;
    const d = 1 + cr * cr;
    return [cx + (x2 - cr * y2) / d, cy + (y2 + cr * x2) / d];
  };

  // ---- digit band (rows) ----
  let vmin = Infinity, vmax = -Infinity;
  for (let i = 0; i < k; i++) { if (v[i] < vmin) vmin = v[i]; if (v[i] > vmax) vmax = v[i]; }
  const vsize = Math.ceil(vmax - vmin) + 2;
  const rowHist = new Int32Array(vsize);
  for (let i = 0; i < k; i++) rowHist[Math.round(v[i] - vmin)]++;
  let maxRow = 0;
  for (let r = 0; r < vsize; r++) if (rowHist[r] > maxRow) maxRow = rowHist[r];
  const rowThr = Math.max(1, 0.06 * maxRow);
  let runs = [];
  for (let r = 0, s = -1; r <= vsize; r++) {
    const on = r < vsize && rowHist[r] >= rowThr;
    if (on && s < 0) s = r;
    if (!on && s >= 0) { runs.push([s, r - 1]); s = -1; }
  }
  // per-run mass and horizontal extent
  const runStats = (rs) => {
    const st = rs.map((r) => ({ r, mass: 0, umin: Infinity, umax: -Infinity }));
    const idx = new Int16Array(vsize).fill(-1);
    rs.forEach((r, j) => { for (let q = r[0]; q <= r[1]; q++) idx[q] = j; });
    for (let i = 0; i < k; i++) {
      const j = idx[Math.round(v[i] - vmin)];
      if (j < 0) continue;
      const S = st[j];
      S.mass++;
      if (u[i] < S.umin) S.umin = u[i]; if (u[i] > S.umax) S.umax = u[i];
    }
    return st;
  };
  // Merge vertically adjacent runs that belong to the same text line, e.g. the
  // upper and lower halves of "17000" (no middle bars at all). A separate blob
  // above/below the digits has a much narrower horizontal extent and is kept apart.
  let rst = runStats(runs);
  for (let merged = true; merged && rst.length > 1;) {
    merged = false;
    for (let j = 0; j < rst.length - 1; j++) {
      const A = rst[j], B = rst[j + 1];
      const gap = B.r[0] - A.r[1] - 1;
      const exA = A.umax - A.umin, exB = B.umax - B.umin;
      const exRatio = Math.min(exA, exB) / Math.max(1, exA, exB);
      const massRatio = Math.min(A.mass, B.mass) / Math.max(1, A.mass, B.mass);
      if (gap <= Math.max(2, 0.3 * (B.r[1] - A.r[0] + 1)) && exRatio >= 0.5 && massRatio >= 0.15) {
        rst.splice(j, 2, {
          r: [A.r[0], B.r[1]], mass: A.mass + B.mass,
          umin: Math.min(A.umin, B.umin), umax: Math.max(A.umax, B.umax),
        });
        merged = true; break;
      }
    }
  }
  // the digit row: lots of lit pixels spread over a wide horizontal extent
  let bestRun = null, bestScore = -1;
  for (const S of rst) {
    const sc = S.mass * Math.sqrt(Math.max(1, S.umax - S.umin));
    if (sc > bestScore) { bestScore = sc; bestRun = S.r; }
  }
  if (!bestRun) return fail('no-band');
  const top = vmin + bestRun[0] - 0.5, bottom = vmin + bestRun[1] + 0.5;
  const H = bottom - top;
  res.digitH = H;
  if (H < o.minDigitH) return fail('small');

  // ---- glyphs (columns) ----
  const padV = 0.04 * H;
  let umin = Infinity, umax = -Infinity;
  for (let i = 0; i < k; i++) {
    if (v[i] < top - padV || v[i] > bottom + padV) continue;
    if (u[i] < umin) umin = u[i]; if (u[i] > umax) umax = u[i];
  }
  const usize = Math.ceil(umax - umin) + 2;
  const colHist = new Int32Array(usize);
  for (let i = 0; i < k; i++) {
    if (v[i] < top - padV || v[i] > bottom + padV) continue;
    colHist[Math.round(u[i] - umin)]++;
  }
  const colThr = Math.max(1, (0.05 * H) / stride);
  runs = [];
  for (let col = 0, s = -1; col <= usize; col++) {
    const on = col < usize && colHist[col] >= colThr;
    if (on && s < 0) s = col;
    if (!on && s >= 0) { runs.push([s, col - 1]); s = -1; }
  }
  // merge tiny fragments into a neighbour only if the result is still digit-sized
  const mergeGap = Math.max(1, Math.round(0.03 * H));
  for (let j = 0; j < runs.length - 1;) {
    const a = runs[j], b = runs[j + 1];
    if (b[0] - a[1] - 1 <= mergeGap && b[1] - a[0] + 1 <= 0.7 * H) runs.splice(j, 2, [a[0], b[1]]);
    else j++;
  }

  // Bucket band points by column (CSR layout) so any column range can be measured quickly.
  const colStart = new Int32Array(usize + 1);
  for (let col = 0; col < usize; col++) colStart[col + 1] = colStart[col] + colHist[col];
  const fillPos = colStart.slice(0, usize);
  const order = new Int32Array(colStart[usize]);
  for (let i = 0; i < k; i++) {
    if (v[i] < top - padV || v[i] > bottom + padV) continue;
    order[fillPos[Math.round(u[i] - umin)]++] = i;
  }
  res.bandFrac = colStart[usize] / k;
  const rowsN = Math.ceil(H) + 2;
  const half = Math.floor((rowsN - 2) / 2);

  // Measure the glyph made of columns c0..c1 (bounding box, row coverage, segment fills).
  const measure = (c0, c1) => {
    const g = {
      c0, c1, cnt: 0, vmin: Infinity, vmax: -Infinity, umin: Infinity, umax: -Infinity,
      xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, w: 0, h: 0,
    };
    const a = colStart[Math.max(0, c0)], b = colStart[Math.min(usize, c1 + 1)];
    const rows = new Uint8Array(rowsN);
    for (let j = a; j < b; j++) {
      const i = order[j];
      g.cnt++;
      if (v[i] < g.vmin) g.vmin = v[i]; if (v[i] > g.vmax) g.vmax = v[i];
      if (u[i] < g.umin) g.umin = u[i]; if (u[i] > g.umax) g.umax = u[i];
      const ox = px[i] + cx, oy = py[i] + cy;
      if (ox < g.xmin) g.xmin = ox; if (ox > g.xmax) g.xmax = ox;
      if (oy < g.ymin) g.ymin = oy; if (oy > g.ymax) g.ymax = oy;
      rows[Math.min(rowsN - 1, Math.max(0, Math.round(v[i] - top)))] = 1;
    }
    if (!g.cnt) return g;
    g.w = g.umax - g.umin + 1;
    g.h = g.vmax - g.vmin + 1;
    g.mass = g.cnt * stride;
    g.isGlyph = g.h >= 0.5 * H && g.mass >= 0.012 * H * H;
    // longest continuous vertical stroke in the upper and lower half (a "1" has one in each)
    let run = 0, best = 0;
    for (let r = 1; r <= half; r++) { run = rows[r] ? run + 1 : 0; if (run > best) best = run; }
    g.cu = best / Math.max(1, half);
    run = 0; best = 0;
    for (let r = half + 1; r < rowsN - 1; r++) { run = rows[r] ? run + 1 : 0; if (run > best) best = run; }
    g.cl = best / Math.max(1, rowsN - 2 - half);
    g.extent = g.h / H;
    const seg = new Float64Array(7);
    for (let j = a; j < b; j++) {
      const i = order[j];
      const uu = (u[i] - g.umin + 0.5) / g.w, vv = (v[i] - top) / H;
      for (let q = 0; q < 7; q++) {
        const R = REGIONS[q];
        if (uu >= R[0] && uu <= R[1] && vv >= R[2] && vv <= R[3]) seg[q]++;
      }
    }
    g.fill = new Float64Array(7);
    for (let q = 0; q < 7; q++) {
      const R = REGIONS[q];
      g.fill[q] = (seg[q] * stride) / Math.max(1, (R[1] - R[0]) * g.w * (R[3] - R[2]) * H);
    }
    return g;
  };

  let G = runs.map(([a, b]) => measure(a, b)).filter((g) => g.cnt);
  const ws0 = G.filter((g) => g.isGlyph && g.w >= 0.3 * H && g.w <= 0.9 * H).map((g) => g.w);
  const Wt = ws0.length ? median(ws0) : 0.58 * H;
  const limit = Math.max(0.72 * H, 1.3 * Wt);
  // segment-fill references ("fully lit" level) from well-separated digit-sized glyphs
  const fillsH = [], fillsV = [];
  for (const g of G) {
    if (!g.isGlyph || g.w < 0.3 * H || g.w > limit) continue;
    for (const q of HORIZ) fillsH.push(g.fill[q]);
    for (const q of VERT) fillsV.push(g.fill[q]);
  }
  const refH = Math.max(0.15, quantile(fillsH, 0.8) || 0.6);
  const refV = Math.max(0.15, quantile(fillsV, 0.8) || 0.6);

  const classify = (g) => {
    g.narrow = g.w < 0.6 * Wt && g.w < 0.36 * H;
    if (g.narrow) {
      // a "1" is two vertical segments: both halves present and (nearly) full height
      const ok = g.cu >= 0.45 && g.cl >= 0.45 && g.extent >= 0.6;
      g.ch = '1';
      g.cost = ok ? 0.3 * (2 - g.cu - g.cl) : 3;
      g.margin = ok ? 1 : 0;
      g.conf = ok ? Math.max(0, Math.min(1, Math.min(g.cu, g.cl) / 0.6)) : 0;
      g.good = ok;
      // a narrow glyph can only be a "1"
      g.costs = new Float64Array(10).fill(4);
      g.costs[1] = g.cost;
      return g;
    }
    const nv = new Float64Array(7);
    for (let q = 0; q < 7; q++) nv[q] = Math.min(1, g.fill[q] / (HORIZ.includes(q) ? refH : refV));
    const perChar = new Map();
    for (const t of TEMPLATES) {
      let cost = 0;
      for (let q = 0; q < 7; q++) cost += Math.abs(nv[q] - t.v[q]);
      if (!perChar.has(t.ch) || cost < perChar.get(t.ch)) perChar.set(t.ch, cost);
    }
    let best = Infinity, second = Infinity, bestCh = '?';
    for (const [ch, cost] of perChar) {
      if (cost < best) { second = best; best = cost; bestCh = ch; } else if (cost < second) second = cost;
    }
    g.ch = bestCh; g.cost = best; g.margin = second - best; g.nv = nv;
    g.conf = Math.max(0, Math.min(1, g.margin / 1.5));
    // segments should be clearly on or off; two or more half-lit ones = ambiguous digit
    let halfLit = 0;
    for (let q = 0; q < 7; q++) if (nv[q] > 0.35 && nv[q] < 0.65) halfLit++;
    g.good = best <= o.maxCost && g.margin >= o.minMargin && halfLit < 2 && bestCh !== '1'; // a real "1" is narrow
    // every digit cell on a display has the same width (only "1" is narrow), so a
    // piece much wider/narrower than the typical digit is not one digit
    const wr = g.w / Wt;
    const widthPen = wr > 1.3 || wr < 0.7 ? 3 : wr > 1.18 || wr < 0.8 ? 0.8 : 0;
    if (widthPen >= 3) g.good = false;
    g.cost += widthPen;
    // cost of reading this glyph as each digit 0-9 (used with the temporal prior)
    g.costs = new Float64Array(10);
    for (let d = 0; d < 10; d++) g.costs[d] = (perChar.get(String(d)) ?? 7) + widthPen + (d === 1 ? 3 : 0);
    return g;
  };

  // Runs wider than one digit (neighbours bridged by glow/noise, typically a narrow
  // "1" glued to the next digit, or an indicator LED glued to a digit) may need
  // splitting. Segmentation by recognition: for every run, enumerate cut points at
  // column-count minima and score each resulting set of pieces by how well they
  // read. Then pick, over all runs together, the combination whose digit count
  // equals the count the display must show (from the plausible range) at the
  // lowest total cost. Without a known count, each extra digit costs a penalty so a
  // clean "0" is never read as "11". Dot-sized leftovers (indicator LEDs, decimal
  // points) are cheap to discard; larger leftovers are not.
  const SPLIT_PENALTY = 0.8, DOT = 0.02 * H * H, MAXK = 4;
  const trigger = Math.max(0.62 * H, 1.12 * Wt);
  const memo = new Map();
  const leafCost = (g) => {
    if (!g.cnt) return { k: 0, cost: 0 };
    if (g.isGlyph) { classify(g); return { k: 1, cost: g.cost + (g.good ? 0 : 2) }; }
    // a dot at the bottom is a decimal point (cheap); one higher up may be a cut-off bar
    return { k: 0, cost: g.mass >= DOT ? 2 : (g.vmin + g.vmax) / 2 > top + 0.6 * H ? 0.3 : 1 };
  };
  // options(c0, c1) -> Map(k -> {cost, parts}): best way to read columns c0..c1 as k glyphs
  const options = (c0, c1, depth) => {
    const key = c0 * 65536 + c1;
    if (memo.has(key)) return memo.get(key);
    const out = new Map();
    const g = measure(c0, c1);
    const lc = leafCost(g);
    out.set(lc.k, { cost: lc.cost, parts: [g] });
    const wid = c1 - c0 + 1;
    if (wid > trigger && wid >= 6 && depth <= 3) {
      const lo = c0 + Math.max(1, Math.floor(0.12 * wid)), hi = c1 - Math.max(1, Math.floor(0.12 * wid));
      const minima = [];
      for (let col = lo; col <= hi; col++) {
        const cv = colHist[col];
        if (cv <= colHist[col - 1] && cv <= colHist[col + 1]) minima.push(col);
      }
      minima.sort((a, b) => colHist[a] - colHist[b]);
      const cuts = [];
      for (const m of minima) {
        if (cuts.every((x) => Math.abs(x - m) > 2)) cuts.push(m);
        if (cuts.length >= 4) break;
      }
      for (const cut of cuts) {
        const cutCost = (colHist[cut] / Math.max(1, (0.1 * H) / stride)) * 0.2;
        const L = options(c0, cut - 1, depth + 1), R = options(cut + 1, c1, depth + 1);
        for (const [kl, a] of L) {
          for (const [kr, b] of R) {
            const k = kl + kr;
            if (k > MAXK) continue;
            const cost = a.cost + b.cost + cutCost;
            if (!out.has(k) || cost < out.get(k).cost) out.set(k, { cost, parts: [...a.parts, ...b.parts] });
          }
        }
      }
    }
    memo.set(key, out);
    return out;
  };
  const runOpts = G.map((g) => options(g.c0, g.c1, 0));
  // dynamic programme over runs: best[k] = cheapest way to obtain k glyphs so far
  let best = new Map([[0, { cost: 0, parts: [] }]]);
  for (const opts of runOpts) {
    const next = new Map();
    for (const [k0, a] of best) {
      for (const [k1, b] of opts) {
        const k = k0 + k1;
        const cost = a.cost + b.cost;
        if (!next.has(k) || cost < next.get(k).cost) next.set(k, { cost, parts: [...a.parts, ...b.parts] });
      }
    }
    best = next;
  }
  const baseK = runOpts.reduce((a, op) => a + Math.min(...op.keys()), 0);
  let choice = null;
  if (o.expectDigits && best.has(o.expectDigits)) choice = best.get(o.expectDigits);
  else {
    let bc = Infinity;
    for (const [k, val] of best) {
      const c = val.cost + SPLIT_PENALTY * Math.max(0, k - Math.max(1, baseK)) + (k === 0 ? 100 : 0);
      if (c < bc) { bc = c; choice = val; }
    }
  }
  const pieces = choice ? choice.parts : G;
  const glyphs = pieces.filter((g) => g.cnt && g.isGlyph).sort((a, b) => a.umin - b.umin);
  for (const g of pieces) if (g.cnt && !g.isGlyph) res.extras.push({ u0: g.umin, u1: g.umax, v0: g.vmin, v1: g.vmax, mass: g.mass });
  if (!glyphs.length) return fail('no-glyphs');
  for (const g of glyphs) {
    if (g.xmin <= 1 || g.xmax >= w - 2 || g.ymin <= 0 || g.ymax >= h - 1) return fail('edge');
  }
  // A sizeable fragment in the upper part of the row, between the digits, means the
  // segmentation went wrong (e.g. the top bar of a "7" cut off, leaving a "1").
  // Dot-sized blobs (indicator LEDs, decimal points, colons) are allowed.
  const spanL = glyphs[0].umin, spanR = glyphs[glyphs.length - 1].umax;
  for (const e of res.extras) {
    const vc = (e.v0 + e.v1) / 2;
    if (e.mass >= DOT && vc < top + 0.6 * H && e.u1 > spanL && e.u0 < spanR) return fail('fragment');
  }

  // A "1" with a bar-shaped stub butting onto its upper left is really a "7" whose
  // top bar was cut off: refuse rather than guess. More generally a "1" occupies the
  // right of its digit cell and the rest of that cell must be dark; lit pixels there
  // mean the "1" is the right half of another digit (e.g. a blurred "3").
  for (const g of glyphs) {
    classify(g);
    if (!g.narrow) continue;
    const cellL = g.umax + 1 - 0.95 * Wt;
    for (const e of res.extras) {
      const uc = (e.u0 + e.u1) / 2, vc = (e.v0 + e.v1) / 2;
      if (uc >= cellL && uc < g.umin && vc < top + 0.45 * H && e.mass >= 0.01 * H * H) return fail('1-not-alone');
    }
    const c0 = Math.max(0, Math.round(g.umax + 1 - 0.85 * Wt - umin)), c1 = Math.round(g.umin - umin) - 2;
    let lit = 0;
    for (let col = c0; col <= c1; col++) lit += colHist[col];
    if (lit * stride > 0.04 * H * H) return fail('1-not-alone');
    for (const e of res.extras) {
      const vc = (e.v0 + e.v1) / 2, ew = e.u1 - e.u0 + 1, eh = e.v1 - e.v0 + 1;
      if (vc < top + 0.4 * H && e.u1 <= g.umin + 1 && e.u1 >= g.umin - 0.25 * Wt && ew >= 0.8 * eh) return fail('fragment-1');
    }
  }

  // Digits sit on a fixed pitch and are right-aligned in their cells ("1" included),
  // so the right edges must be evenly spaced. An irregular set means the row was
  // cut into the wrong pieces.
  if (glyphs.length >= 3) {
    const n = glyphs.length, R = glyphs.map((g) => g.umax);
    const im = (n - 1) / 2, rm = R.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0;
    for (let i = 0; i < n; i++) { sxy += (i - im) * (R[i] - rm); sxx += (i - im) ** 2; }
    const P = sxy / sxx;
    let worst = 0;
    for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(R[i] - (rm + P * (i - im))));
    res.pitch = P / H;
    if (P < 0.55 * H || P > 1.4 * H || worst > Math.max(2, 0.14 * P)) return fail('pitch');
  }

  // The segmentation is sound. Report every glyph, plus the cost of reading it as
  // each digit 0-9 (the "lattice"): even when one digit is too ambiguous for a
  // stand-alone reading, the lattice lets the temporal tracker test whether the
  // digits fit the value expected from the previous readings.
  for (const g of glyphs) {
    const quad = [toOrig(g.umin, top), toOrig(g.umax + 1, top), toOrig(g.umax + 1, bottom), toOrig(g.umin, bottom)];
    const d = { ch: g.ch, conf: g.conf, cost: g.cost, margin: g.margin, quad };
    if (g.narrow) Object.assign(d, { cover: [+g.cu.toFixed(2), +g.cl.toFixed(2)], wid: +(g.w / H).toFixed(2), extent: +g.extent.toFixed(2) });
    else d.fills = Array.from(g.nv, (x) => +x.toFixed(2));
    res.digits.push(d);
  }
  const u0 = glyphs[0].umin, u1 = glyphs[glyphs.length - 1].umax + 1;
  res.bandQuad = [toOrig(u0, top), toOrig(u1, top), toOrig(u1, bottom), toOrig(u0, bottom)];
  if (!o.expectDigits || glyphs.length === o.expectDigits) res.lattice = { n: glyphs.length, costs: glyphs.map((g) => g.costs) };

  let text = '', minConf = 1;
  for (const g of glyphs) {
    if (!g.good) return fail(g.narrow ? 'partial-1' : 'unknown-glyph');
    text += g.ch; minConf = Math.min(minConf, g.conf);
  }
  res.text = text;
  res.conf = minConf;
  res.ok = true;
  return res;
}

// --------------------------------------------------------------- stage 1 --

/**
 * Coarse localisation of the display: returns candidate boxes (in this
 * image's pixel coordinates) sorted by score.
 */
export function locateDisplay(rgba, w, h, opts = {}) {
  const o = { ...LOCATE_DEFAULTS, ...opts };
  const n = w * h;
  const out = { candidates: [], threshold: 0, contrast: 0 };
  if (w < 8 || h < 8) return out;
  const sm = blur3(scoreImage(rgba, n, o.colorMode, o.strictness), w, h);
  const th = adaptiveThreshold(sm, n, o);
  out.threshold = th.T; out.contrast = th.contrast;
  if (th.contrast < o.minContrast) return out;
  const T = th.T;
  const mask = new Uint8Array(n);
  for (let i = 0; i < n; i++) mask[i] = sm[i] > T ? 1 : 0;
  // 3x3 dilation so that segments of one digit (and close digits) connect
  const dl = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < w) dl[yy * w + xx] = 1;
        }
      }
    }
  }
  // connected components (8-connectivity, union-find)
  const lab = new Int32Array(n);
  const parent = new Int32Array(Math.floor(n / 2) + 2);
  let next = 1;
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const unite = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!dl[i]) continue;
      let m = 0;
      const nb = [x > 0 ? lab[i - 1] : 0, y > 0 && x > 0 ? lab[i - w - 1] : 0, y > 0 ? lab[i - w] : 0, y > 0 && x < w - 1 ? lab[i - w + 1] : 0];
      for (const L of nb) if (L && (!m || L < m)) m = L;
      if (!m) {
        if (next >= parent.length) return out; // pathological noise
        parent[next] = next; lab[i] = next++;
      } else {
        lab[i] = m;
        for (const L of nb) if (L && L !== m) unite(L, m);
      }
    }
  }
  const comps = new Map();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lab[i]) continue;
      const r = find(lab[i]);
      let c = comps.get(r);
      if (!c) { c = { x0: x, x1: x, y0: y, y1: y, mass: 0 }; comps.set(r, c); }
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      if (mask[i]) c.mass++;
    }
  }
  let list = [...comps.values()].filter((c) => c.mass >= 2);
  if (list.length > 300) list = list.sort((a, b) => b.mass - a.mass).slice(0, 300);
  // group components that sit side by side on one text line
  const P = list.map((_, i) => i);
  const f2 = (a) => { while (P[a] !== a) { P[a] = P[P[a]]; a = P[a]; } return a; };
  for (let i = 0; i < list.length; i++) {
    const A = list[i];
    for (let j = i + 1; j < list.length; j++) {
      const B = list[j];
      const mh = Math.max(A.y1 - A.y0 + 1, B.y1 - B.y0 + 1);
      const gx = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
      const gy = Math.max(0, Math.max(A.y0, B.y0) - Math.min(A.y1, B.y1));
      if (gx <= 0.7 * mh && gy <= 0.35 * mh) { const a = f2(i), b = f2(j); if (a !== b) P[b] = a; }
    }
  }
  const groups = new Map();
  list.forEach((c, i) => {
    const r = f2(i);
    let g = groups.get(r);
    if (!g) { g = { x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, mass: 0, n: 0 }; groups.set(r, g); }
    g.x0 = Math.min(g.x0, c.x0); g.x1 = Math.max(g.x1, c.x1);
    g.y0 = Math.min(g.y0, c.y0); g.y1 = Math.max(g.y1, c.y1);
    g.mass += c.mass; g.n++;
  });
  // second-level merge: neighbouring groups of similar height on the same line
  const GL = [...groups.values()];
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let i = 0; i < GL.length; i++) {
      for (let j = i + 1; j < GL.length; j++) {
        const A = GL[i], B = GL[j];
        const hA = A.y1 - A.y0 + 1, hB = B.y1 - B.y0 + 1, mh = Math.max(hA, hB), nh = Math.min(hA, hB);
        const oy = Math.min(A.y1, B.y1) - Math.max(A.y0, B.y0) + 1;
        const gx = Math.max(0, Math.max(A.x0, B.x0) - Math.min(A.x1, B.x1));
        if (nh >= 0.5 * mh && oy >= 0.5 * nh && gx <= 1.0 * mh) {
          A.x0 = Math.min(A.x0, B.x0); A.x1 = Math.max(A.x1, B.x1);
          A.y0 = Math.min(A.y0, B.y0); A.y1 = Math.max(A.y1, B.y1);
          A.mass += B.mass; A.n += B.n;
          GL.splice(j, 1); changed = true; break outer;
        }
      }
    }
  }
  const cands = [];
  for (const g of GL) {
    const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
    if (gh < o.minH) continue;
    const aspect = gw / gh, fill = g.mass / (gw * gh);
    let f = 1;
    if (aspect < 0.7 || aspect > 14) f *= 0.15;
    if (fill > 0.8) f *= 0.3;
    if (o.prev) {
      const d = Math.hypot((g.x0 + g.x1) / 2 - o.prev.cx, (g.y0 + g.y1) / 2 - o.prev.cy) / Math.max(o.prev.h, gh, 1);
      f *= 1 + 3 * Math.exp((-d * d) / 8);
    }
    cands.push({
      x: g.x0, y: g.y0, w: gw, h: gh, mass: g.mass, parts: g.n, score: g.mass * f,
      touchesEdge: g.x0 <= 0 || g.y0 <= 0 || g.x1 >= w - 1 || g.y1 >= h - 1,
    });
  }
  cands.sort((a, b) => b.score - a.score);
  out.candidates = cands.slice(0, o.maxCandidates);
  return out;
}

// ------------------------------------------------------------ validation --

/** Number of digits implied by the plausible range, or 0 if it varies. */
export function expectedDigits(minKg, maxKg, multiplier = 1) {
  const a = String(Math.round(minKg / multiplier)).length, b = String(Math.round(maxKg / multiplier)).length;
  return a === b ? a : 0;
}

/** Plausibility checks on a decoded digit string. */
export function validateReading(text, conf, cfg) {
  if (!text) return { ok: false, why: 'empty' };
  const exp = cfg.expectDigits ?? expectedDigits(cfg.minKg, cfg.maxKg, cfg.multiplier || 1);
  if (exp && text.length !== exp) return { ok: false, why: 'digits' };
  const value = parseInt(text, 10) * (cfg.multiplier || 1);
  if (!Number.isFinite(value)) return { ok: false, why: 'nan' };
  if (value < cfg.minKg || value > cfg.maxKg) return { ok: false, why: 'range', value };
  if (cfg.stepKg > 0 && value % cfg.stepKg !== 0) return { ok: false, why: 'step', value };
  if (conf < (cfg.minConf ?? 0)) return { ok: false, why: 'conf', value };
  return { ok: true, value };
}
