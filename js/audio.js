// Alert tones via Web Audio. iOS needs unlock() from a user gesture.

export class Beeper {
  constructor() { this.ctx = null; this.muted = false; }

  unlock() {
    try {
      // play even when the ring/silent switch is on (Safari 16.4+)
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch { /* not supported */ }
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      const b = this.ctx.createBuffer(1, 1, 22050);
      const s = this.ctx.createBufferSource();
      s.buffer = b; s.connect(this.ctx.destination); s.start(0);
    } catch { /* ignore */ }
  }

  tone(freq, at, dur, gain = 0.35, type = 'square') {
    const c = this.ctx;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(gain, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    o.connect(g); g.connect(c.destination);
    o.start(at); o.stop(at + dur + 0.02);
  }

  play(kind) {
    if (this.muted || !this.ctx) return;
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = this.ctx.currentTime + 0.02;
    const seq = {
      fast: [[1046, 0, 0.16], [784, 0.2, 0.16], [1046, 0.5, 0.16], [784, 0.7, 0.22]],   // falling: slow down
      slow: [[784, 0, 0.16], [1046, 0.2, 0.16], [784, 0.5, 0.16], [1046, 0.7, 0.22]],   // rising: speed up
      ok: [[880, 0, 0.12, 0.2, 'sine'], [1318, 0.13, 0.18, 0.2, 'sine']],
      start: [[1318, 0, 0.08, 0.2, 'sine']],
      end: [[988, 0, 0.1, 0.2, 'sine'], [740, 0.14, 0.16, 0.2, 'sine']],
    }[kind];
    if (!seq) return;
    for (const [f, d, dur, g, ty] of seq) this.tone(f, t + d, dur, g, ty);
  }
}
