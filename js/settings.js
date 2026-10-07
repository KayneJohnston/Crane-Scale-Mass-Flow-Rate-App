// User settings: defaults, persistence (localStorage) and the settings-form schema.

const KEY = 'tapRate.settings.v1';

export const DEFAULTS = {
  targetKgMin: 600,
  tolPct: 10,
  windows: '20,40,60,120',
  // scale display
  minKg: 10000,
  maxKg: 30000,
  stepKg: 50,
  multiplier: 1,
  // camera & vision
  resolution: '4k',
  hwZoom: true,
  colorMode: 'auto',
  strictness: 1,
  procFps: 10,
  minConf: 0.15,
  videoFps: 8,
  temporal: true,
  relockFrames: 3,
  // automatic start / stop
  autoStart: true,
  autoStop: true,
  stallSec: 120,
  lostSec: 45,
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
    group: 'Camera & vision',
    items: [
      { key: 'resolution', label: 'Camera resolution', type: 'select', options: [['4k', '4K (best at distance)'], ['1080p', '1080p'], ['720p', '720p (battery saver)']] },
      { key: 'hwZoom', label: 'Use the camera’s own zoom when available', type: 'checkbox' },
      { key: 'colorMode', label: 'Digit colour', type: 'select', options: [['auto', 'Auto (red, then any bright)'], ['red', 'Red only'], ['bright', 'Any bright digits']] },
      { key: 'strictness', label: 'Red strictness', type: 'number', min: 0.3, max: 1.5, step: 0.05, help: 'Lower it if bright digits look white/pink on screen (over-exposed).' },
      { key: 'procFps', label: 'Frames analysed per second', type: 'number', min: 2, max: 20, step: 1 },
      { key: 'videoFps', label: 'Video analysis frames per second', type: 'number', min: 2, max: 30, step: 1 },
      { key: 'temporal', label: 'Check each reading against the previous ones', type: 'checkbox', help: 'A reading far from the last few (e.g. 20050 then 10050) is only believed once it repeats; unclear frames are resolved using the expected value.' },
      { key: 'relockFrames', label: 'Frames needed to believe a sudden jump', type: 'number', min: 1, max: 10, step: 1 },
    ],
  },
  {
    group: 'Automatic start / stop',
    items: [
      { key: 'autoStart', label: 'Start when the weight starts rising', type: 'checkbox' },
      { key: 'autoStop', label: 'Stop automatically', type: 'checkbox' },
      { key: 'stallSec', label: 'Stop when weight has not risen for', unit: 's', type: 'number', min: 20, max: 1200, step: 5 },
      { key: 'lostSec', label: 'Stop when the display is lost for', unit: 's', type: 'number', min: 5, max: 600, step: 5 },
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
