// Lightweight canvas time-series charts (no dependencies).
// Stacked panels share the time axis; each panel has its own single y-axis
// (weight and rate are never put on one plot with two scales).

export const COLORS = {
  surface: '#151a20',
  grid: '#252c35',
  axis: '#3a424c',
  muted: '#898781',
  ink: '#ffffff',
  ink2: '#c3c2b7',
  s1: '#3987e5',      // categorical slot 1 (blue)
  s2: '#d95926',      // categorical slot 2 (orange)
  good: '#0ca30c',    // status: on target
  serious: '#ec835a', // status: rejected reading
};

const FONT = '11px -apple-system, system-ui, "Segoe UI", sans-serif';
const FONT_B = '600 12px -apple-system, system-ui, "Segoe UI", sans-serif';

export function niceTicks(min, max, count = 4) {
  if (!(max > min)) { max = min + 1; }
  const span = max - min;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(6));
  return { ticks, step };
}

export const fmtInt = (v) => Math.round(v).toLocaleString('en-US');
export function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function rgba(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class TimeChart {
  constructor(canvas, { onDoubleTap } = {}) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.spec = null;
    this.hoverX = null;
    this.hoverTimer = null;
    let lastTap = 0;
    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return e.clientX - r.left;
    };
    canvas.addEventListener('pointerdown', (e) => {
      const now = performance.now();
      if (now - lastTap < 300 && onDoubleTap) { onDoubleTap(); lastTap = 0; return; }
      lastTap = now;
      this.setHover(pos(e));
      canvas.setPointerCapture?.(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType !== 'mouse' || this.hoverX != null) this.setHover(pos(e)); });
    canvas.addEventListener('pointerup', () => this.releaseHover());
    canvas.addEventListener('pointercancel', () => this.releaseHover());
    canvas.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') this.releaseHover(0); });
  }

  setHover(x) { clearTimeout(this.hoverTimer); this.hoverX = x; this.draw(); }
  releaseHover(delay = 2500) {
    clearTimeout(this.hoverTimer);
    this.hoverTimer = setTimeout(() => { this.hoverX = null; this.draw(); }, delay);
  }

  render(spec) { this.spec = spec; this.draw(); }

  draw() {
    const cv = this.cv, spec = this.spec;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!spec || !spec.panels?.length) {
      ctx.fillStyle = COLORS.muted; ctx.font = FONT; ctx.textAlign = 'center';
      ctx.fillText(spec?.empty || 'No data yet', W / 2, H / 2);
      return;
    }
    const L = 46, R = 10, xAxisH = 16;
    const x0 = spec.x0, x1 = spec.x1 > spec.x0 ? spec.x1 : spec.x0 + 1;
    const px = (t) => L + ((t - x0) / (x1 - x0)) * (W - L - R);
    const totalFrac = spec.panels.reduce((a, p) => a + (p.frac || 1), 0);
    let top = 2;
    const avail = H - xAxisH - 4;
    const panelGeom = [];
    for (const p of spec.panels) {
      const ph = (avail * (p.frac || 1)) / totalFrac;
      panelGeom.push(this.drawPanel(ctx, p, { top, h: ph, L, R, W, px }));
      top += ph;
    }
    // shared x axis
    const xt = niceTicks(x0, x1, Math.max(2, Math.floor((W - L - R) / 70)));
    ctx.fillStyle = COLORS.muted; ctx.font = FONT; ctx.textBaseline = 'top';
    for (const t of xt.ticks) {
      const label = (spec.xfmt || fmtClock)(t), tw = ctx.measureText(label).width, X = px(t);
      ctx.textAlign = X + tw / 2 > W - 1 ? 'right' : X - tw / 2 < 0 ? 'left' : 'center';
      ctx.fillText(label, ctx.textAlign === 'right' ? W - 1 : X, H - xAxisH + 2);
    }
    // crosshair + tooltip
    if (this.hoverX != null && spec.hover) this.drawHover(ctx, spec, panelGeom, { L, R, W, H, px, x0, x1 });
  }

  drawPanel(ctx, p, g) {
    const legendH = 16;
    const top = g.top + legendH, bot = g.top + g.h - 4;
    let ymin = p.ymin, ymax = p.ymax;
    if (ymin == null || ymax == null) {
      let lo = Infinity, hi = -Infinity;
      for (const it of p.items) {
        // rejected points (crosses) must not stretch the axis; they are drawn clamped to the edge
        const arrs = it.type === 'area' ? [it.lo, it.hi] : it.type === 'band' || it.type === 'cross' || it.type === 'vspan' ? [] : [it.ys];
        for (const a of arrs) for (const v of a || []) if (v != null && Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      }
      if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
      const pad = Math.max((hi - lo) * 0.08, p.minSpan ? (p.minSpan - (hi - lo)) / 2 : 0, 1);
      if (ymin == null) ymin = lo - pad;
      if (ymax == null) ymax = hi + pad;
    }
    const py = (v) => bot - ((v - ymin) / (ymax - ymin)) * (bot - top);
    // grid + y labels
    const yt = niceTicks(ymin, ymax, Math.max(2, Math.floor((bot - top) / 28)));
    ctx.lineWidth = 1;
    ctx.font = FONT; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of yt.ticks) {
      const y = Math.round(py(v)) + 0.5;
      ctx.strokeStyle = COLORS.grid;
      ctx.beginPath(); ctx.moveTo(g.L, y); ctx.lineTo(g.W - g.R, y); ctx.stroke();
      if (y < top + 5) continue; // label would collide with the legend row
      ctx.fillStyle = COLORS.muted;
      ctx.fillText((p.yfmt || fmtInt)(v), g.L - 5, y);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(g.L, top - 1, g.W - g.L - g.R, bot - top + 2); ctx.clip();
    for (const it of p.items) this.drawItem(ctx, it, g.px, py, { top, bot, L: g.L, W: g.W, R: g.R });
    ctx.restore();
    // legend (text in ink colours, colour carried by the key mark)
    let lx = g.L;
    const ly = g.top + 8;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.font = FONT_B; ctx.fillStyle = COLORS.ink2;
    const title = p.title || '';
    ctx.fillText(title, lx, ly);
    lx += ctx.measureText(title).width + 10;
    ctx.font = FONT;
    for (const it of p.items) {
      if (!it.label) continue;
      const kw = 14;
      if (lx + kw + ctx.measureText(it.label).width > g.W - g.R) break;
      if (it.type === 'line') { ctx.strokeStyle = it.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 12, ly); ctx.stroke(); }
      else if (it.type === 'dots') { ctx.fillStyle = it.color; ctx.beginPath(); ctx.arc(lx + 6, ly, 3, 0, 7); ctx.fill(); }
      else if (it.type === 'cross') { this.cross(ctx, lx + 6, ly, 3.5, it.color); }
      else { ctx.fillStyle = rgba(it.color, Math.max(0.3, it.alpha || 0.2)); ctx.fillRect(lx, ly - 5, 12, 10); }
      ctx.fillStyle = COLORS.muted;
      ctx.fillText(it.label, lx + kw + 2, ly);
      lx += kw + 2 + ctx.measureText(it.label).width + 10;
    }
    if (p.note && lx + ctx.measureText(p.note).width + 4 < g.W - g.R) {
      ctx.textAlign = 'right'; ctx.fillStyle = COLORS.muted; ctx.fillText(p.note, g.W - g.R, ly);
    }
    return { p, py, top, bot, ymin, ymax };
  }

  cross(ctx, x, y, s, color) {
    ctx.strokeStyle = color; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s); ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s); ctx.stroke();
  }

  drawItem(ctx, it, px, py, g) {
    if (it.type === 'band') {
      ctx.fillStyle = rgba(it.color, it.alpha ?? 0.14);
      const y0 = py(it.y1), y1 = py(it.y0);
      ctx.fillRect(g.L, y0, g.W - g.L - g.R, y1 - y0);
      if (it.mid != null) {
        ctx.strokeStyle = rgba(it.color, 0.6); ctx.lineWidth = 1;
        const y = Math.round(py(it.mid)) + 0.5;
        ctx.beginPath(); ctx.moveTo(g.L, y); ctx.lineTo(g.W - g.R, y); ctx.stroke();
      }
    } else if (it.type === 'vspan') {
      ctx.fillStyle = rgba(it.color, it.alpha ?? 0.08);
      for (const [a, b] of it.spans) ctx.fillRect(px(a), g.top, px(b) - px(a), g.bot - g.top);
    } else if (it.type === 'area') {
      ctx.fillStyle = rgba(it.color, it.alpha ?? 0.15);
      let open = false, first = -1;
      const flush = (end) => {
        if (first < 0) return;
        ctx.beginPath();
        ctx.moveTo(px(it.xs[first]), py(it.hi[first]));
        for (let i = first + 1; i <= end; i++) ctx.lineTo(px(it.xs[i]), py(it.hi[i]));
        for (let i = end; i >= first; i--) ctx.lineTo(px(it.xs[i]), py(it.lo[i]));
        ctx.closePath(); ctx.fill();
        first = -1;
      };
      for (let i = 0; i < it.xs.length; i++) {
        const ok = it.lo[i] != null && it.hi[i] != null && (!it.gap || i === 0 || it.xs[i] - it.xs[i - 1] <= it.gap);
        if (ok && !open) { first = i; open = true; }
        if (!ok && open) { flush(i - 1); open = false; if (it.lo[i] != null && it.hi[i] != null) { first = i; open = true; } }
      }
      if (open) flush(it.xs.length - 1);
    } else if (it.type === 'line') {
      ctx.strokeStyle = it.color; ctx.lineWidth = it.width || 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < it.xs.length; i++) {
        const v = it.ys[i];
        if (v == null || !Number.isFinite(v) || (it.gap && i && it.xs[i] - it.xs[i - 1] > it.gap)) { pen = false; if (v == null) continue; }
        const X = px(it.xs[i]), Y = py(v);
        if (!pen) { ctx.moveTo(X, Y); pen = true; } else ctx.lineTo(X, Y);
      }
      ctx.stroke();
      if (it.endDot && it.xs.length) {
        let i = it.ys.length - 1;
        while (i >= 0 && it.ys[i] == null) i--;
        if (i >= 0) {
          ctx.fillStyle = COLORS.surface; ctx.beginPath(); ctx.arc(px(it.xs[i]), py(it.ys[i]), 6, 0, 7); ctx.fill();
          ctx.fillStyle = it.color; ctx.beginPath(); ctx.arc(px(it.xs[i]), py(it.ys[i]), 4, 0, 7); ctx.fill();
        }
      }
    } else if (it.type === 'dots') {
      ctx.fillStyle = rgba(it.color, it.alpha ?? 0.6);
      const r = it.r || 1.6;
      for (let i = 0; i < it.xs.length; i++) {
        if (it.ys[i] == null) continue;
        ctx.beginPath(); ctx.arc(px(it.xs[i]), py(it.ys[i]), r, 0, 7); ctx.fill();
      }
    } else if (it.type === 'cross') {
      for (let i = 0; i < it.xs.length; i++) {
        if (it.ys[i] == null) continue;
        const y = Math.min(g.bot - 4, Math.max(g.top + 4, py(it.ys[i])));
        this.cross(ctx, px(it.xs[i]), y, 3, it.color);
      }
    }
  }

  drawHover(ctx, spec, geoms, g) {
    const t = g.x0 + ((this.hoverX - g.L) / (g.W - g.L - g.R)) * (g.x1 - g.x0);
    const rows = spec.hover(t);
    if (!rows) return;
    const X = Math.round(g.px(rows.t)) + 0.5;
    if (X < g.L || X > g.W - g.R) return;
    ctx.strokeStyle = COLORS.ink2; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(X, geoms[0].top - 14); ctx.lineTo(X, g.H - 16); ctx.stroke();
    // tooltip
    ctx.font = FONT_B;
    const lines = [{ v: rows.title, l: '' }, ...rows.rows];
    let w = 0;
    for (const r of lines) {
      ctx.font = FONT_B; let lw = ctx.measureText(r.v).width;
      ctx.font = FONT; lw += r.l ? ctx.measureText(' ' + r.l).width + (r.color ? 16 : 0) : 0;
      w = Math.max(w, lw);
    }
    const bw = w + 16, bh = lines.length * 16 + 8;
    let bx = X + 8;
    if (bx + bw > g.W - 2) bx = X - 8 - bw;
    const by = geoms[0].top - 10;
    ctx.fillStyle = 'rgba(8,10,13,0.92)'; ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(bx, by, bw, bh, 8) : ctx.rect(bx, by, bw, bh); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    lines.forEach((r, i) => {
      const y = by + 12 + i * 16;
      let x = bx + 8;
      if (r.color) { ctx.strokeStyle = r.color; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 10, y); ctx.stroke(); x += 16; }
      ctx.font = FONT_B; ctx.fillStyle = i === 0 ? COLORS.ink2 : COLORS.ink; ctx.fillText(r.v, x, y);
      if (r.l) { const vw = ctx.measureText(r.v).width; ctx.font = FONT; ctx.fillStyle = COLORS.muted; ctx.fillText(' ' + r.l, x + vw, y); }
    });
  }
}

// nearest index in a sorted array
export function nearestIndex(xs, t) {
  let lo = 0, hi = xs.length - 1;
  if (hi < 0) return -1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (xs[mid] < t) lo = mid + 1; else hi = mid; }
  if (lo > 0 && Math.abs(xs[lo - 1] - t) < Math.abs(xs[lo] - t)) lo--;
  return lo;
}
