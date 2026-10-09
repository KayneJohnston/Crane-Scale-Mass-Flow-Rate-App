// User settings: defaults, persistence (localStorage) and the settings-form schema.

const KEY = 'tapRate.settings.v1';

export const DEFAULTS = {
  targetKgMin: 600,
  tolPct: 10,
  windows: '20,40,60,120',
  // scale display
  minKg: 1000,
  maxKg: 40000,
  stepKg: 50,
  multiplier: 1,
  // camera & vision
  lowPower: false,
  resolution: '4k',
  hwZoom: true,
  colorMode: 'auto',
  strictness: 1,
  procFps: 10,
  minConf: 0.15,
  videoFps: 8,
  temporal: true,
  relockFrames: 3,
  collectCrops: true,
  // automatic start / stop
  autoStart: true,
  autoStop: true,
  stallSec: 180,
  lostSec: 180,
  startMinRiseKg: 80,
  // filter
  rateVar: 100,
  warmupSec: 12,
  // alerts
  beep: true,
  beepRepeatSec: 20,
  // misc
  deviceId: '',
  saveDemo: true,
  debug: false,
  zoom: 1,
  lastMeta: { crucible: '', crew: '', operator: '' },
};

export const SCHEMA = [
  {
    group: 'Target',
    items: [
      { key: 'targetKgMin', label: 'Target tap rate', unit: 'kg/min', type: 'number', min: 50, max: 5000, step: 10 },
      { key: 'tolPct', label: 'Tolerance ±', unit: '%', type: 'number', min: 1, max: 50, step: 1 },
      { key: 'windows', label: 'Rate windows', unit: 's', type: 'text', help: 'Comma separated, up to four, e.g. 20,40,60,120.' },
    ],
  },
  {
    group: 'Scale display',
    items: [
      { key: 'minKg', label: 'Lowest plausible reading', unit: 'kg', type: 'number', min: 0, step: 50 },
      { key: 'maxKg', label: 'Highest plausible reading', unit: 'kg', type: 'number', min: 0, step: 50 },
      { key: 'stepKg', label: 'Display step', unit: 'kg', type: 'number', min: 1, step: 1 },
      {
        key: 'multiplier', label: 'Display shows', type: 'select',
        options: [[1, 'kg, e.g. 20050'], [10, 'tonnes, 2 decimals (20.05)'], [100, 'tonnes, 1 decimal (20.1)'], [1000, 'tonnes, no decimals']],
      },
    ],
    help: 'Readings outside the plausible range, or not a multiple of the step, are treated as misreads.',
  },
  {
    group: 'Battery',
    items: [
      {
        key: 'lowPower', label: 'Low power mode', type: 'checkbox',
        help: 'Camera at 1080p and 15 frames/s instead of 4K at 30, 3 readings a second instead of 10 (just as accurate for the tap rate in tests), and the camera picture dims while the display is being read (tap it to see it again). Also the 🔋 button on the live screen.',
      },
    ],
  },
  {
    group: 'Camera & vision',
    items: [
      { key: 'resolution', label: 'Camera resolution', type: 'select', options: [['4k', '4K (best at distance)'], ['1080p', '1080p'], ['720p', '720p (battery saver)']] },
      { key: 'hwZoom', label: 'Use the camera’s own zoom when available', type: 'checkbox' },
      { key: 'colorMode', label: 'Digit colour', type: 'select', options: [['auto', 'Auto (recommended)'], ['red', 'Red digits'], ['hot', 'Over-exposed (white digits in red glow)'], ['bright', 'Any bright digits']] },
      { key: 'strictness', label: 'Red strictness', type: 'number', min: 0.3, max: 1.5, step: 0.05, help: 'Lower it if bright digits look white/pink on screen (over-exposed).' },
      { key: 'procFps', label: 'Frames analysed per second', type: 'number', min: 2, max: 20, step: 1 },
      { key: 'videoFps', label: 'Video analysis frames per second', type: 'number', min: 2, max: 30, step: 1 },
      { key: 'temporal', label: 'Check each reading against the previous ones', type: 'checkbox', help: 'A reading far from the last few (e.g. 20050 then 10050) is only believed once it repeats; unclear frames are resolved using the expected value.' },
      { key: 'relockFrames', label: 'Frames needed to believe a sudden jump', type: 'number', min: 1, max: 10, step: 1 },
      { key: 'collectCrops', label: 'Keep hard-to-read frames for review', type: 'checkbox', help: 'Pictures of the display from frames the app could not read or had to guess (at most one every 3 s and 20 every 10 minutes, 200 in all) stay on this phone for you to label in Review, and to export.' },
    ],
  },
  {
    group: 'Automatic start / stop',
    items: [
      { key: 'autoStart', label: 'Start when the weight starts rising', type: 'checkbox' },
      { key: 'autoStop', label: 'Stop automatically', type: 'checkbox' },
      { key: 'stallSec', label: 'Stop when weight has not risen for', unit: 's', type: 'number', min: 20, max: 1200, step: 5, help: 'Must be longer than a pot change (crane move + vacuum build-up, about 2 min) or the crucible is split into one recording per pot.' },
      { key: 'lostSec', label: 'Stop when the display is lost for', unit: 's', type: 'number', min: 5, max: 600, step: 5, help: 'Long enough for the crane move between pots. The recording ends at the last reading, not at this time-out.' },
      { key: 'startMinRiseKg', label: 'Rise needed to start', unit: 'kg', type: 'number', min: 50, max: 1000, step: 10 },
    ],
  },
  {
    group: 'Rate filter (advanced)',
    items: [
      { key: 'rateVar', label: 'Tap-rate variability', unit: 'kg/min/min', type: 'number', min: 10, max: 600, step: 10, help: 'How fast the true tap rate is assumed to change. Higher reacts faster but is noisier. 100 is calibrated so the shown 90% range holds ~90% of the time in simulation.' },
      { key: 'warmupSec', label: 'Settling time after a tap starts', unit: 's', type: 'number', min: 0, max: 60, step: 1 },
    ],
  },
  {
    group: 'Alerts',
    items: [
      { key: 'beep', label: 'Beep when the rate goes red', type: 'checkbox' },
      { key: 'beepRepeatSec', label: 'Repeat beep every', unit: 's', type: 'number', min: 5, max: 300, step: 5 },
      { key: 'saveDemo', label: 'Save demo runs in History', type: 'checkbox' },
    ],
  },
];

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { s = {}; }
  // Saved settings include the defaults of their time. Move an old default to the new
  // one unless the user changed it:
  const rev = +s.settingsRev || 0;
  // v0.2's range (10,000-30,000 kg) refused e.g. an empty crucible at 3,050 kg
  if (rev < 2 && +s.minKg === 10000 && +s.maxKg === 30000) { delete s.minKg; delete s.maxKg; }
  // up to v0.3.4 the recording stopped 2 min after the weight stopped rising (45 s
  // without a reading), which split a crucible at every pot change
  if (rev < 3) {
    if (+s.stallSec === 120) delete s.stallSec;
    if (+s.lostSec === 45) delete s.lostSec;
  }
  s.settingsRev = 3;
  return { ...DEFAULTS, ...s, lastMeta: { ...DEFAULTS.lastMeta, ...(s.lastMeta || {}) } };
}

export function saveSettings(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode etc. */ }
}

export function resetSettings() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return loadSettings();
}

export function parseWindows(text) {
  const w = String(text).split(/[,\s]+/).map(Number).filter((x) => x >= 5 && x <= 1800);
  const uniq = [...new Set(w)].sort((a, b) => a - b).slice(0, 4);
  return uniq.length ? uniq : [20, 40, 60, 120];
}

// What the app spends on each part of its work, normally and in low power mode. The
// camera stream is the biggest cost after the screen: 1080p at 15 frames/s is an
// eighth of the pixels a second of 4K at 30 (with the camera's own zoom the digits
// keep their pixels). Three readings a second are as accurate for the tap rate as
// ten in simulated taps, even with a third of the frames unreadable; below two
// the start of a tap is missed.
export function powerProfile(s) {
  const low = !!s.lowPower;
  const procFps = Math.min(30, Math.max(1, +s.procFps || 10));
  const videoFps = Math.min(30, Math.max(1, +s.videoFps || 8));
  return {
    low,
    resolution: low && s.resolution === '4k' ? '1080p' : s.resolution,
    camFps: low ? 15 : 30,
    procFps: low ? Math.min(3, procFps) : procFps,
    searchFps: low ? 1 : procFps,  // while the display is out of view
    videoFps: low ? Math.min(3, videoFps) : videoFps,
    uiMs: low ? 1000 : 200,        // numbers and alarms
    chartMs: low ? 3000 : 500,
    saveMs: low ? 30000 : 10000,   // saving the tap in progress
  };
}

export function engineConfig(s) {
  return {
    targetKgMin: +s.targetKgMin, tolPct: +s.tolPct, windows: parseWindows(s.windows), stepKg: +s.stepKg,
    rateVar: +s.rateVar, autoStart: !!s.autoStart, autoStop: !!s.autoStop, stallSec: +s.stallSec,
    lostSec: +s.lostSec, warmupSec: +s.warmupSec, startMinRiseKg: +s.startMinRiseKg,
  };
}

export function readerConfig(s) {
  return {
    colorMode: s.colorMode, strictness: +s.strictness, minKg: +s.minKg, maxKg: +s.maxKg,
    stepKg: +s.stepKg, multiplier: +s.multiplier, minConf: +s.minConf,
    temporal: s.temporal !== false, relockFrames: Math.max(1, Math.round(+s.relockFrames || 3)),
  };
}
