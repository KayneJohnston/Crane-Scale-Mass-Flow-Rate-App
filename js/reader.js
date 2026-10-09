// Browser adapter for the vision pipeline: samples pixels from a <video> or
// <canvas> with drawImage and runs readFrame() on them.

import { readFrame } from './vision/pipeline.js';
import { DisplayTracker } from './vision/tracker.js';

export class BrowserReader {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.track = {};
  }

  sampler(el) {
    const cv = this.canvas;
    return (x, y, w, h, dw, dh) => {
      if (cv.width !== dw || cv.height !== dh) { cv.width = dw; cv.height = dh; }
      const ctx = this.ctx;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(el, x, y, w, h, 0, 0, dw, dh);
      return ctx.getImageData(0, 0, dw, dh).data;
    };
  }

  /** t: frame time in seconds (enables the check against previous readings). */
  read(el, srcW, srcH, view, cfg, t = null) {
    const t0 = performance.now();
    let res;
    try {
      res = readFrame(this.sampler(el), srcW, srcH, view, cfg, this.track, t);
    } catch (e) {
      res = { ok: false, reason: 'error: ' + (e?.message || e), value: null, conf: 0 };
    }
    res.ms = performance.now() - t0;
    return res;
  }

  resetTracking() { this.track = {}; }

  /**
   * The person read v off the display at time t (corrected: the reading they corrected).
   * Returns what untell() needs to take it back.
   */
  tell(t, v, cfg, corrected = null) {
    return (this.track.tracker ||= new DisplayTracker()).told(t, v, cfg, corrected);
  }

  untell(undo) { this.track.tracker?.undoTold(undo); }
}
