// Synthetic seven-segment LED display renderer.
//
// Used by the in-app demo ("fake camera"), the automated tests and the icon
// generator. Pure JS with no DOM access: it writes RGBA pixels into a
// Uint8ClampedArray, so it runs both in the browser and in Node.

export const SEGMENTS_FOR = {
  '0': 'abcdef', '1': 'bc', '2': 'abdeg', '3': 'abcdg', '4': 'bcfg',
  '5': 'acdfg', '6': 'acdefg', '7': 'abc', '8': 'abcdefg', '9': 'abcdfg',
  '-': 'g', ' ': '',
};

export const RENDER_DEFAULTS = {
  text: '20050',
  digitH: 60,          // digit height in pixels
  widthRatio: 0.56,    // digit width / height
  thickRatio: 0.14,    // segment thickness / height
  gapRatio: 0.02,      // gap between neighbouring segments / height
  pitchRatio: 0.80,    // distance between digit origins / height
  cx: null, cy: null,  // centre of the text line (default: image centre)
  slantDeg: 8,         // italic slant (positive = leans right)
  rotDeg: 0,           // in-plane rotation of the whole display
  bg: [14, 14, 16],
  panel: true, panelColor: [26, 22, 24], panelPad: 0.35,
  panelPadL: null, panelPadR: null,   // optional asymmetric horizontal padding (default panelPad)
  lit: [255, 38, 28],
  ghost: 0, ghostColor: [80, 16, 14],   // visibility of unlit segments (0..1)
  hot: 0,              // over-exposed whitish segment cores (0..1)
  glow: 0.35, glowRadius: 0.07,
  glowColor: null,     // colour of the glow (default: the lit colour). Over-exposed displays:
                       // lit = cream core, glowColor = saturated red bloom
  bezel: null,         // {color:[r,g,b], width} light frame around the display window
  blur: 0,             // optical blur radius in px
  noise: 4,            // gaussian sensor noise (std, 0..255 scale)
  gain: 1,
  glare: [],           // [{x, y, r, i}] additive white blobs (x,y,r in px)
  clutter: [],         // [{x, y, r, color:[r,g,b]}] solid discs elsewhere in the scene
  dp: -1,              // index of the digit followed by a decimal point (-1 = none)
  leds: [],            // [{u, v, r}] lit indicator dots, in digit heights from the top-left of the first cell
  dashes: [],          // [{u0, u1}] lit bars at the middle-segment height (a real display showed "-2-1800"), in digit heights from the left of the first cell
  hlines: [],          // [{v, t}] lit horizontal lines across the digit row (a window lip reflecting
                       // the glow), top at v and t thick, in digit heights from the top of the digits
  seed: 1,
};

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussFactory(rnd) {
  let spare = null;
  return function gauss() {
    if (spare !== null) { const s = spare; spare = null; return s; }
    let u = 0, v = 0;
    while (u === 0) u = rnd();
    v = rnd();
    const r = Math.sqrt(-2 * Math.log(u));
    spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  };
}

// Hexagonal segment polygons for one digit cell with its top-left at (0,0).
function segmentPolygons(w, h, t, g) {
  const ht = t / 2;
  const hz = (x0, x1, y) => [[x0, y], [x0 + ht, y - ht], [x1 - ht, y - ht], [x1, y], [x1 - ht, y + ht], [x0 + ht, y + ht]];
  const vt = (x, y0, y1) => [[x, y0], [x + ht, y0 + ht], [x + ht, y1 - ht], [x, y1], [x - ht, y1 - ht], [x - ht, y0 + ht]];
  const xl = ht, xr = w - ht, yt = ht, ym = h / 2, yb = h - ht;
  return {
    a: hz(xl + g, xr - g, yt),
    g: hz(xl + g, xr - g, ym),
    d: hz(xl + g, xr - g, yb),
    f: vt(xl, yt + g, ym - g),
    b: vt(xr, yt + g, ym - g),
    e: vt(xl, ym + g, yb - g),
    c: vt(xr, ym + g, yb - g),
  };
}

// Rasterise a convex polygon into a coverage layer using 3x3 supersampling.
function fillConvex(layer, W, H, poly, value = 1) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of poly) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(W - 1, Math.ceil(maxX));
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
  if (x0 > x1 || y0 > y1) return;
  const n = poly.length;
  // orientation of the polygon
  let area = 0;
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
    area += ax * by - bx * ay;
  }
  const sgn = area >= 0 ? 1 : -1;
  const inside = (px, py) => {
    for (let i = 0; i < n; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % n];
      if (sgn * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0) return false;
    }
    return true;
  };
  const offs = [1 / 6, 0.5, 5 / 6];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let c = 0;
      for (const oy of offs) for (const ox of offs) if (inside(x + ox, y + oy)) c++;
      if (c) {
        const v = (c / 9) * value;
        const i = y * W + x;
        if (v > layer[i]) layer[i] = v;
      }
    }
  }
}

// In-place separable box blur of a float layer (radius r, `passes` times ≈ gaussian).
export function boxBlurFloat(src, W, H, r, passes = 2) {
  if (r < 1) return src;
  const tmp = new Float32Array(W * H);
  let a = src, b = tmp;
  for (let p = 0; p < passes; p++) {
    // horizontal a -> b
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(W - 1, Math.max(0, x))];
      for (let x = 0; x < W; x++) {
        b[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    // vertical b -> a
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(H - 1, Math.max(0, y)) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = acc / (2 * r + 1);
        acc += b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];
      }
    }
  }
  return a;
}

/**
 * Render a seven-segment display into `buf` (RGBA, W*H*4).
 * Returns geometry info: {cx, cy, totalW, digitH} in pixels.
 */
export function renderDisplay(buf, W, H, opts = {}) {
  const o = { ...RENDER_DEFAULTS, ...opts };
  const rnd = mulberry32(o.seed);
  const gauss = gaussFactory(rnd);
  const Hd = o.digitH, Wd = Hd * o.widthRatio, t = Hd * o.thickRatio, g = Hd * o.gapRatio;
  const pitch = Hd * o.pitchRatio;
  const n = o.text.length;
  const totalW = (n - 1) * pitch + Wd;
  const cx = o.cx ?? W / 2, cy = o.cy ?? H / 2;
  const tanS = Math.tan((o.slantDeg * Math.PI) / 180);
  const rot = (o.rotDeg * Math.PI) / 180, cr = Math.cos(rot), sr = Math.sin(rot);
  const toImg = (x, y) => {
    const xs = x + (Hd - y) * tanS - totalW / 2 - (Hd * tanS) / 2;
    const ys = y - Hd / 2;
    return [cx + xs * cr - ys * sr, cy + xs * sr + ys * cr];
  };

  const N = W * H;
  const lit = new Float32Array(N), ghost = new Float32Array(N);
  const polys = segmentPolygons(Wd, Hd, t, g);
  for (let i = 0; i < n; i++) {
    const on = SEGMENTS_FOR[o.text[i]] ?? '';
    for (const s of 'abcdefg') {
      const poly = polys[s].map(([x, y]) => toImg(x + i * pitch, y));
      fillConvex(on.includes(s) ? lit : ghost, W, H, poly);
    }
    if (o.dp === i) {
      const s = t * 1.1, x = i * pitch + Wd + (pitch - Wd) / 2 - s / 2, y = Hd - s;
      fillConvex(lit, W, H, [[x, y], [x + s, y], [x + s, y + s], [x, y + s]].map(([a, b]) => toImg(a, b)));
    }
  }
  for (const d of o.leds) {
    const pts = [];
    for (let k = 0; k < 12; k++) {
      const a = (k / 12) * 2 * Math.PI;
      pts.push(toImg((d.u + d.r * Math.cos(a)) * Hd, (d.v + d.r * Math.sin(a)) * Hd));
    }
    fillConvex(lit, W, H, pts);
  }
  for (const d of o.dashes) {
    const v0 = Hd / 2 - t / 2, v1 = Hd / 2 + t / 2;
    fillConvex(lit, W, H, [[d.u0 * Hd, v0], [d.u1 * Hd, v0], [d.u1 * Hd, v1], [d.u0 * Hd, v1]].map(([a, b]) => toImg(a, b)));
  }
  for (const ln of o.hlines) {
    const u0 = -0.3 * Hd, u1 = (n - 1) * pitch + Wd + 0.3 * Hd, v0 = ln.v * Hd, v1 = (ln.v + ln.t) * Hd;
    fillConvex(lit, W, H, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([a, b]) => toImg(a, b)));
  }
  if (o.blur >= 1) { boxBlurFloat(lit, W, H, Math.round(o.blur)); boxBlurFloat(ghost, W, H, Math.round(o.blur)); }
  let glowL = null;
  if (o.glow > 0) {
    glowL = Float32Array.from(lit);
    boxBlurFloat(glowL, W, H, Math.max(1, Math.round(o.glowRadius * Hd)), 3);
  }

  const padX = totalW / 2 + Hd * tanS / 2, padY = Hd / 2 + Hd * o.panelPad;
  const padL = padX + Hd * (o.panelPadL ?? o.panelPad), padR = padX + Hd * (o.panelPadR ?? o.panelPad);
  const glowC = o.glowColor || o.lit;
  const bz = o.bezel ? o.bezel.width * Hd : 0;
  for (let y = 0, i = 0, p = 0; y < H; y++) {
    for (let x = 0; x < W; x++, i++, p += 4) {
      let r = o.bg[0], gg = o.bg[1], b = o.bg[2];
      if (o.panel) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const lx = dx * cr + dy * sr, ly = -dx * sr + dy * cr;
        if (lx >= -padL && lx <= padR && Math.abs(ly) <= padY) { r = o.panelColor[0]; gg = o.panelColor[1]; b = o.panelColor[2]; }
        else if (bz && lx >= -padL - bz && lx <= padR + bz && Math.abs(ly) <= padY + bz) { r = o.bezel.color[0]; gg = o.bezel.color[1]; b = o.bezel.color[2]; }
      }
      for (const c of o.clutter) {
        const d2 = (x - c.x) ** 2 + (y - c.y) ** 2;
        if (d2 <= c.r * c.r) { r = c.color[0]; gg = c.color[1]; b = c.color[2]; }
      }
      const gv = ghost[i] * o.ghost;
      r += gv * o.ghostColor[0]; gg += gv * o.ghostColor[1]; b += gv * o.ghostColor[2];
      const lv = lit[i] * o.gain;
      r += lv * o.lit[0]; gg += lv * o.lit[1]; b += lv * o.lit[2];
      if (o.hot > 0) { const h2 = lit[i] * lit[i] * o.hot; gg += h2 * 190; b += h2 * 180; }
      if (glowL) { const gl = glowL[i] * o.glow; r += gl * glowC[0]; gg += gl * glowC[1]; b += gl * glowC[2]; }
      for (const gl of o.glare) {
        const d2 = (x - gl.x) ** 2 + (y - gl.y) ** 2;
        const v = gl.i * Math.exp(-d2 / (2 * gl.r * gl.r));
        r += v; gg += v * (gl.g ?? 1); b += v * (gl.b ?? 1);
      }
      if (o.noise > 0) { r += gauss() * o.noise; gg += gauss() * o.noise; b += gauss() * o.noise; }
      buf[p] = r; buf[p + 1] = gg; buf[p + 2] = b; buf[p + 3] = 255; // Uint8ClampedArray clamps
    }
  }
  return { cx, cy, totalW, digitH: Hd };
}
