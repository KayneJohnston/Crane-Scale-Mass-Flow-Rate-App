// Rear camera access, lens/zoom control and screen wake lock.

const RES = { '4k': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720] };

export class Camera {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
  }

  get active() { return !!(this.track && this.track.readyState === 'live'); }

  async start({ deviceId = '', resolution = '4k', fps = 30 } = {}) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Camera not available. Open the app over https in Safari.');
    }
    this.stop();
    const [w, h] = RES[resolution] || RES['1080p'];
    const base = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: fps, max: fps } };
    const attempts = [];
    if (deviceId) attempts.push({ ...base, deviceId: { exact: deviceId } });
    attempts.push({ ...base, facingMode: { ideal: 'environment' } });
    attempts.push({ facingMode: { ideal: 'environment' } });
    let err;
    for (const video of attempts) {
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
        break;
      } catch (e) { err = e; }
    }
    if (!this.stream) throw err || new Error('Could not open the camera');
    this.track = this.stream.getVideoTracks()[0];
    const v = this.video;
    v.removeAttribute('src');
    v.srcObject = this.stream;
    v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    try { await v.play(); } catch { /* autoplay quirks; frames still arrive */ }
    const t0 = performance.now();
    while (!(v.videoWidth > 0) && performance.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
    return { width: v.videoWidth, height: v.videoHeight, label: this.track.label, settings: this.track.getSettings?.() || {} };
  }

  stop() {
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null; this.track = null;
    if (this.video.srcObject) this.video.srcObject = null;
  }

  zoomCaps() {
    try {
      const c = this.track?.getCapabilities?.();
      if (c?.zoom && c.zoom.max > c.zoom.min) return c.zoom;
    } catch { /* not supported */ }
    return null;
  }

  async setZoom(z) {
    const caps = this.zoomCaps();
    if (!caps) return false;
    const v = Math.min(caps.max, Math.max(caps.min, z));
    try { await this.track.applyConstraints({ advanced: [{ zoom: v }] }); return true; } catch { return false; }
  }

  static async listCameras() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === 'videoinput');
    } catch { return []; }
  }
}

export class WakeLock {
  constructor() { this.lock = null; this.want = false; }

  async request() {
    this.want = true;
    try {
      if ('wakeLock' in navigator && !this.lock) {
        this.lock = await navigator.wakeLock.request('screen');
        this.lock.addEventListener?.('release', () => { this.lock = null; });
      }
    } catch { this.lock = null; }
  }

  async release() {
    this.want = false;
    try { await this.lock?.release(); } catch { /* ignore */ }
    this.lock = null;
  }

  /** Call on visibilitychange: locks are dropped when the page is hidden. */
  async refresh() { if (this.want && !this.lock && document.visibilityState === 'visible') await this.request(); }
}
