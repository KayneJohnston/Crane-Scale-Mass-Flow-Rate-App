// Pure-JS equivalent of canvas drawImage(src, x, y, w, h, 0, 0, dw, dh):
// supersampled bilinear resampling of an RGBA buffer. Used by the tests and
// by any non-DOM consumer of the vision pipeline.

export function makeSampler(rgba, W, H) {
  const px = (x, y, ch) => {
    x = x < 0 ? 0 : x > W - 1 ? W - 1 : x;
    y = y < 0 ? 0 : y > H - 1 ? H - 1 : y;
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const fx = x - x0, fy = y - y0;
    const a = rgba[(y0 * W + x0) * 4 + ch], b = rgba[(y0 * W + x1) * 4 + ch];
    const c = rgba[(y1 * W + x0) * 4 + ch], d = rgba[(y1 * W + x1) * 4 + ch];
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  };
  return function sample(x, y, w, h, dw, dh) {
    const out = new Uint8ClampedArray(dw * dh * 4);
    const sx = w / dw, sy = h / dh;
    const nx = Math.min(4, Math.max(1, Math.ceil(sx))), ny = Math.min(4, Math.max(1, Math.ceil(sy)));
    for (let j = 0; j < dh; j++) {
      for (let i = 0; i < dw; i++) {
        let r = 0, g = 0, b = 0;
        for (let v = 0; v < ny; v++) {
          const yy = y + (j + (v + 0.5) / ny) * sy - 0.5;
          for (let u = 0; u < nx; u++) {
            const xx = x + (i + (u + 0.5) / nx) * sx - 0.5;
            r += px(xx, yy, 0); g += px(xx, yy, 1); b += px(xx, yy, 2);
          }
        }
        const k = nx * ny, p = (j * dw + i) * 4;
        out[p] = r / k; out[p + 1] = g / k; out[p + 2] = b / k; out[p + 3] = 255;
      }
    }
    return out;
  };
}
