// Generate the PNG app icons from the seven-segment renderer:  node tools/make-icons.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderDisplay } from '../js/vision/render7seg.js';
import { encodePNG } from './png.js';

function icon(size, { safe = 1 } = {}) {
  const buf = new Uint8ClampedArray(size * size * 4);
  renderDisplay(buf, size, size, {
    text: '600', digitH: size * 0.36 * safe, cx: size / 2, cy: size * 0.46,
    slantDeg: 8, glow: 0.55, glowRadius: 0.09, noise: 0, bg: [14, 16, 20], panel: false,
    lit: [255, 52, 40], thickRatio: 0.15, pitchRatio: 0.78,
  });
  // green "on target" bar under the digits
  const y0 = Math.round(size * (0.46 + 0.25 * safe)), h = Math.max(2, Math.round(size * 0.035 * safe));
  const x0 = Math.round(size * (0.5 - 0.27 * safe)), x1 = Math.round(size * (0.5 + 0.27 * safe));
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x1; x++) {
      const p = (y * size + x) * 4;
      buf[p] = 48; buf[p + 1] = 209; buf[p + 2] = 88; buf[p + 3] = 255;
    }
  }
  return encodePNG(buf, size, size);
}

mkdirSync('icons', { recursive: true });
writeFileSync('icons/icon-192.png', icon(192));
writeFileSync('icons/icon-512.png', icon(512));
writeFileSync('icons/apple-touch-icon.png', icon(180));
writeFileSync('icons/icon-maskable-512.png', icon(512, { safe: 0.8 }));
console.log('icons written');
