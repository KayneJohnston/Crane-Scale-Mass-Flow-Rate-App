# Tap Rate: crane-scale mass-flow-rate app

An iPhone web app that reads the red seven-segment display of a crane scale with the camera, records the weight while a crucible is tapped, and shows the **tap rate in kg/min against a target (600 kg/min ±10%)**:

- **Red ⬇: too fast, slow down.**
- **Red ⬆: too slow, speed up.**
- **Green ↔: on target.**

It also shows 20/40/60/120-second and whole-tap averages. It ignores the scale jitter and 50 kg steps, rejects "touch" events (crucible resting on the cell), saves every tap, and exports CSV.

No App Store, no account, no server. It's a web page you add to the home screen. All data stays on the phone until you export it.

<p align="center"><img src="docs/screenshot-live.png" width="300" alt="Live screen during a simulated tap"> <img src="docs/screenshot-history.png" width="300" alt="Saved tap with per-tap statistics"></p>

---

## 1. Get it on your iPhone

**One-time setup (repo owner):** turn on GitHub Pages so the app has a web address.

1. On GitHub open **Settings → Pages**.
2. Under *Build and deployment*, set **Source** to **Deploy from a branch**.
3. Pick **Branch**: `main` (or this development branch, `claude/crane-scale-app-discovery-9gfo7l`) and folder **/ (root)**, then press **Save**.
4. After about a minute the app is live at **https://kaynejohnston.github.io/Crane-Scale-Mass-Flow-Rate-App/**.

**On each phone (you and your friends):**

1. Open that link in **Safari** (iPhone 13 or newer recommended; iOS 16.4+).
2. Tap **Share → Add to Home Screen**. It then opens full-screen like an app and works without signal once it has been loaded.
3. Open it, tap **Start camera**, and allow camera access.

**Try it without a crane:** Settings → **Run demo**, or open the link with `?demo=5` on the end. It plays a simulated tap with realistic noise, cathode touches and camera misreads.

---

## 2. Using it at the pot

1. **Aim and zoom.** Point at the scale display and pinch (or use the slider) until the red digits are clearly visible in the camera box. Drag to pan, double-tap to reset. A **green box** means the number is being read. **Amber** means digits were found but not read; the badge says why ("zoom in", "digits cut off", …). On Pro iPhones choose the *Telephoto* lens in Settings → Camera for 15 m work. The 4K camera setting gives the most pixels on the digits.
2. **Recording starts automatically** when the weight starts rising. It needs about 3 standard errors of evidence and more than 120 kg of rise, and the start time is back-dated to the true onset. Recording **stops automatically** when the weight hasn't risen by 100 kg for **2 minutes**, or when the display has been out of view for **45 s** (both adjustable). **Start tap now / End tap** override this, and the **Auto** box turns automation off.
3. **Read the big number.** It is the current tap rate (Kalman filter, explained below) with its 90% uncertainty:

   | Display | Meaning |
   |---|---|
   | **Red ⬇ "Too fast — slow down"** | rate above target + 10% |
   | **Red ⬆ "Too slow — speed up"** | rate below target − 10% |
   | **Green ↔ "On target"** | within ±10% |
   | **Striped** red or green | the point estimate says so, but the 90% interval still overlaps the band edge (*not yet certain*) |
   | Grey "Measuring…" | first ~12 s of a tap, while the estimate settles |
   | Grey "Flow dropping…" | rate collapsing (the tap is ending); no alarm unless it stays low for 15 s |
   | Grey "No flow" / "Display lost" | no metal going in / camera can't see the number |

   A beep sounds when it goes red. Falling tones mean slow down; rising tones mean speed up. It repeats every 20 s while red. Mute with 🔔.
4. **Tiles:** average rate over the last **20, 40, 60, 120 s** and the **whole tap so far**, each with a ± 90% range. Tiles fill in once enough of the window has elapsed.
5. **⚠ Touch** flashes while readings are impossibly low (crucible resting on the cathode). Those readings are excluded from every calculation.
6. **Details:** pot number(s), crucible ID, crew, operator, notes. These can be entered during the tap, or you're asked when it ends. Crew, crucible and operator are remembered.
7. **History:** every tap with mass, duration, average rate (green/red), peak 60 s rate, % of time fast / on target / slow, and touch count. **Export CSV** gives a summary (one row per tap). Each recording can export its full 0.5 s data or every raw camera frame. **Backup / Import** moves everything as JSON between phones.

**Several pots into one crucible:** if the crane moves to the next pot within 2 minutes, the recording continues. Each pot's tap is detected and reported separately (Tap 1, Tap 2, …).

**Recorded video instead of live:** film the display with the normal Camera app (zoomed in, phone steady), then use Settings → **Analyse a video…**. Frame the digits, then press **Analyse video**. It runs at about 2× real time.

**Battery / screen:** the app keeps the screen awake while the camera runs. If your iOS version doesn't, set *Settings → Display & Brightness → Auto-Lock* to a longer time.

---

## 3. How the numbers are calculated (and why they're defensible)

### 3.1 From pixels to a weight reading
Each analysed frame (10 per second) goes through these steps:

1. A *redness* image is computed (R − max(G, B)), which rejects white glare, and the area is downscaled.
2. The display is located as a row of red blobs.
3. A tight crop is taken at full camera resolution and rescaled so digits are about 48 px tall.
4. The crop is thresholded halfway between background and segment brightness, which is the edge of a blurred stroke.
5. Hand-held tilt and the italic slant are removed by maximising the sharpness of the row and column projections.
6. The digit row is split into digits, using the fact that the display must show exactly as many digits as the plausible range implies (5 for 10,000–30,000 kg).
7. The 7 segment regions of each digit are measured and matched to templates. A digit must win by a clear margin.

A reading is accepted only if it has the right number of digits, lies in the plausible range, and is a multiple of 50 kg. Several sanity checks also apply:

- The digits must sit on an evenly spaced pitch.
- A "1" must have an empty cell to its left.
- No digit may have half-lit segments.
- "Any bright digits" mode needs a clearer win.

**The reader prefers "no reading" to a wrong reading.** On 5,000 synthetic frames (blur, glow, glare, ghost segments, over-exposure, tilt, 12–70 px digits, indicator LEDs, clutter) it reads about 91% of normal and 85% of deliberately hard frames. There was **1 wrong value in 5,000**: a red object painted over part of a digit. The steps below still catch isolated misreads: 0.5 s medians and the Kalman gate.

### 3.2 From frames to measurements
Frame readings are grouped into **0.5 s bins and the median is taken**. This removes single-frame misreads and LED multiplexing flicker. Each bin is one measurement: about 2 per second.

### 3.3 The big number: live tap rate (robust Kalman filter)
The crucible mass *m* and tap rate *q* follow a **local linear trend** model:

```
m(t+dt) = m(t) + q(t)·dt            mass grows at the tap rate
q(t+dt) = q(t) + w,  w ~ N(0, S·dt)   the tap rate can drift (operator adjusts the siphon)
reading = m + v,     v ~ N(0, R)      scale noise + 50 kg rounding
```

The Kalman filter for this model is the textbook optimal real-time estimator. It is exactly the causal form of a **cubic smoothing spline** through the weight curve, and the displayed rate is that spline's slope.

- **R (scale noise)** is estimated from the data itself. It uses the robust spread (MAD) of the second differences of recent readings, which cancels the trend. The floor is 50²/12, the variance of 50 kg rounding.
- **S (how fast the true rate can change)** is set by *Tap-rate variability* = 100 kg/min per minute. In simulation this setting gives the lowest error, and the **stated 90% interval contains the true rate about 90% of the time**, so the ± is honest.
- **The 600 kg/min target is *not* used as a prior.** That would pull estimates toward "on target" and make the tool unfair. The expected 300–1500 kg/min range is used only for plausibility checks. The rate must be ≥ 0 because metal can't flow out, and rates above 3000 kg/min are rejected as impossible.

### 3.4 Touches, bounces and misreads: the physics does the work
**Metal can't leave the crucible**, so a reading well below the mass already established is physically impossible. That means the crucible is resting on the cathode or cell. The established mass is the median of the last 10 s of accepted readings. A reading more than 3.5 σ below it is flagged as **touch** and excluded until the operator lifts the crucible.

Readings far above the prediction (spikes, bounces on lift-off, misreads) are excluded too, unless they persist, are self-consistent and are physically reachable. In that case the filter re-locks onto them. Moderate outliers are down-weighted (Huber). The filter re-initialises if it is clearly lagging a real change.

### 3.5 Window tiles (20/40/60/120 s)
Each tile is the **Theil–Sen slope**: the median of the slopes between all pairs of accepted readings in the window. It is a standard robust regression that is unaffected by up to about 29% outliers. Its ± uses a MAD noise estimate, inflated for autocorrelation, because crane swing makes neighbouring readings correlated.

The scale only moves in 50 kg steps, and at 600 kg/min that is one step every 5 s. So short windows are inherently imprecise. With typical noise (σ ≈ 40 kg) the 90% precision is roughly:

| window | 20 s | 40 s | 60 s | 120 s |
|---|---|---|---|---|
| ± (90%) | ~110 kg/min (18%) | ~40 (6%) | ~21 (3.5%) | ~7 (1%) |

That is why the main number uses the filter, which combines all the data optimally, and shows its own ±.

### 3.6 The tap average (saved per tap)
**Average rate = mass delivered ÷ tap duration.** This is the definition of an average flow rate, not a regression slope.

- **Start and end** of the tap are change-points found by a least-squares hinge fit (flat→rising, rising→flat).
- **Mass delivered** = median of the stable readings in the 20 s after the tap minus the median of the 20 s before. Crane swing averages out and touches are excluded.

The ± combines the uncertainty of both levels with ±1 s on each change-point. On simulated 6-minute taps the delivered mass comes out exact and the average is within about 0.5%.

### 3.7 Colours
**Green** = inside target ±10%. **Red** = outside, with 1% hysteresis so it doesn't flicker. It is **solid** when the 90% interval is entirely on one side of the band edge, and **striped** when the evidence isn't conclusive yet. Beeps sound when red is certain, or after it has been "likely red" for 8 s.

---

## 4. Tuning the camera reading with your scale

The vision was developed on a realistic simulator, so real footage will improve it. Please send:

1. **A short video** (10–60 s) of the display filmed from where you'd stand, with the iPhone Camera app at the zoom you'd use. Ideally include one with glare.
2. A **screenshot with the debug panel on** (👁 button). It shows the crop, the threshold mask, digit height, slant and the reason a frame failed. **Save snapshot** exports a full-resolution frame.

Settings that may matter:

- **Digit colour:** *Auto* tries red, then any bright digit.
- **Red strictness:** lower it if the digits look white or pink on screen, i.e. over-exposed.
- **Plausible range:** this also sets the digit count, 5 for 10,000–30,000 kg.
- **Display shows:** choose this if the display shows tonnes with a decimal point.

---

## 5. Data files

**`tap_…csv`**: one row per 0.5 s. The header lines (`#`) hold the session, pots, crucible, crew, target and per-tap results.

| column | meaning |
|---|---|
| `time_s`, `clock` | seconds since recording start, local time |
| `reading_kg`, `frames` | median of the camera readings in that 0.5 s, number of frames |
| `flag` | `ok`, `slow` (accepted, down-weighted), `touch`, `spike` (rejected), `pre` (before the tap) |
| `kalman_mass_kg`, `kalman_rate_kg_min`, `kalman_rate_ci90` | live filter state |
| `rate_20s_kg_min` … | window rates as shown on the tiles |
| `level_10s_kg`, `status` | robust current level; indicator state shown |

**`…_frames.csv`**: every analysed camera frame (time, value or blank, confidence).

**`tap-rate-summary-….csv`**: one row per tap across all recordings (date, pots, crucible, crew, start, end, mass, average, ±, verdict, peak 60 s, % fast/ok/slow, touches).

---

## 6. Development

Plain ES modules with no build step and no dependencies. GitHub Pages serves the repo as-is.

```
index.html, css/, manifest.webmanifest, sw.js, icons/   the app shell (PWA, offline)
js/main.js                 controller: camera/video/demo -> reader -> engine -> UI
js/vision/sevenseg.js      seven-segment locator + reader (pure functions on RGBA)
js/vision/pipeline.js      two-stage frame reader, sampler-agnostic
js/analysis/engine.js      binning, robust Kalman, windows, flow on/off, auto start/stop
js/analysis/kalman.js      local linear trend Kalman filter
js/analysis/stats.js       Theil–Sen + SE, hinge change-points, robust noise
js/analysis/offline.js     per-tap results after a recording
js/analysis/sim.js         realistic tap simulator (noise, swing, touches, misreads)
js/vision/render7seg.js    synthetic seven-segment renderer (tests, demo, icons)
tests/                     node --test unit tests;  tests/e2e/ Playwright end-to-end
tools/                     vision evaluation/debug, test video, icons, local server
```

```bash
npm test                              # unit tests (vision accuracy, statistics, engine on simulated taps)
node tools/vision-eval.mjs 500 --hard # Monte-Carlo read-rate / wrong-read check
node tools/engine-run.mjs 3           # one simulated tap through the engine
node tests/e2e/smoke.mjs out/         # headless Chromium: demo -> history
node tests/e2e/camera.mjs out/        # fake camera stream -> live session
node tests/e2e/video.mjs out/         # synthetic video file -> analysis (needs ffmpeg)
node tools/serve.mjs 8080             # serve locally (camera needs https or localhost)
```
