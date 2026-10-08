# Live tap-rate filter benchmark

Is the app's Kalman filter the best way to turn the scale readings into a live tap rate?
This benchmark runs 20 alternatives on simulated taps and compares them to it.

```bash
node tools/filter-bench/run.mjs             # ~3 min on 4 cores (simulated taps are cached in the temp dir)
node tools/filter-bench/run.mjs --quick     # a rough look in ~1 min
node tools/filter-bench/run.mjs --only Holt,Kalman --json out.json
```

## How it is made fair

- **Same input for everyone.** Each simulated tap goes through the real engine once. Every
  candidate then gets the same half-second readings in the same order. It also gets the
  engine's decisions about which readings were touches or misreads, the same noise
  estimate, and the same starting point at the flow onset. Only the estimation method differs.
- **Tuned, then tested on different taps.** Each candidate's settings are picked on 12
  taps of each kind (lowest error averaged over the kinds). It is then scored on 30 *other*
  taps of each kind: 210 test taps. Settings were widened until the best one was inside the range
  tried, except where the best is the method becoming a plain Kalman filter (see below).
- **Seven kinds of tap:** standard; near the target (600–690 kg/min); abrupt vacuum changes
  (760 → 560 → 660 kg/min); noisy scale (2× noise and swing); clean scale; low power (3 frames/s,
  15% unread); messy (5× misreads, 4 touches, 20% unread).
- **A realistic swing.** Each tap gets its own swing period (3–6 s), and the amplitude
  comes and goes. The plain simulator's constant 4.3 s sine would flatter a swing model.
- **Error** = live rate vs the true rate at that moment, from 20 s after the tap starts
  to its end, touches excluded. Win/diff columns compare each candidate with the shipped
  filter tap by tap. The 95% interval is a bootstrap over the 210 test taps.

## Results (v0.3.4)

RMS error of the live rate, % of the true rate (lower is better):

| # | Estimator | std | near | steps | noisy | clean | lowpw | messy | **mean** | vs shipped [95% CI] | status flips/min* |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Kalman + load-swing model (bank of 19 periods) | 5.9 | 5.1 | 8.6 | 6.9 | 5.0 | 5.8 | 6.0 | **6.18** | −0.05 [−0.08, −0.02] | 1.72 |
| 2 | Blend: shipped Kalman + window least squares | 5.9 | 5.1 | 8.7 | 7.0 | 5.0 | 5.8 | 6.0 | **6.22** | −0.02 [−0.03, −0.00] | 2.33 |
| 3 | H-infinity (minimax) | 6.0 | 4.9 | 8.9 | 6.8 | 5.1 | 5.9 | 6.1 | **6.23** | +0.00 [−0.04, 0.04] | 1.92 |
| 4 | **Kalman (as shipped)** | 5.9 | 5.2 | 8.6 | 7.1 | 5.0 | 5.8 | 6.0 | **6.23** | — | 2.71 |
| 5 | Kalman, Student-t (outlier-tolerant) | 5.9 | 5.2 | 8.6 | 7.1 | 5.0 | 5.8 | 6.0 | 6.24 | +0.01 | 2.55 |
| 6 | Fixed-lag smoother (shown 6 s late) | 6.0 | 5.1 | 8.8 | 7.0 | 5.1 | 5.9 | 6.1 | 6.26 | +0.02 | 1.90 |
| 7 | Kalman, same model retuned (plain) | 6.0 | 5.1 | 8.7 | 7.0 | 5.1 | 5.9 | 6.1 | 6.26 | +0.03 | 2.30 |
| 8 | IMM (steady + changing models) | 5.9 | 5.1 | 8.7 | 7.1 | 5.1 | 5.9 | 6.1 | 6.27 | +0.04 | 2.52 |
| 9 | Kalman, self-adjusting (innovation bias) | 6.0 | 5.0 | 8.9 | 7.0 | 5.1 | 5.9 | 6.1 | 6.28 | +0.05 | 1.93 |
| 10 | LOESS (tricube, last 45 s) | 5.9 | 5.0 | 8.8 | 7.0 | 5.5 | 5.9 | 6.2 | 6.35 | +0.12 | 1.52 |
| 11 | Discounted least squares (Brown) | 6.0 | 5.0 | 8.9 | 7.2 | 5.5 | 6.0 | 6.2 | 6.43 | +0.22 | 2.88 |
| 12 | Theil–Sen slope, last 40 s | 6.3 | 5.0 | 9.5 | 7.1 | 6.0 | 6.4 | 6.5 | 6.66 | +0.42 | 1.40 |
| 13 | Least-squares slope, last 40 s | 6.3 | 5.0 | 9.6 | 7.1 | 6.1 | 6.4 | 6.6 | 6.73 | +0.49 | 1.09 |
| 14 | Holt linear exponential smoothing | 6.3 | 5.8 | 8.7 | 8.4 | 5.2 | 7.2 | 8.9 | 7.21 | +0.78 | 3.52 |
| 15 | Kalman, constant acceleration | 6.5 | 6.1 | 11.2 | 8.0 | 5.3 | 6.9 | 6.6 | 7.22 | +0.90 | 1.63 |
| 16 | Alpha-beta (critically damped) | 6.3 | 5.9 | 8.7 | 8.6 | 5.1 | 7.2 | 8.8 | 7.23 | +0.83 | 3.71 |
| 17 | Particle filter (300 particles, heavy-tailed) | 7.1 | 7.5 | 9.2 | 9.8 | 6.4 | 8.1 | 7.7 | 7.96 | +1.68 | 7.73 |
| 18 | Savitzky–Golay (quadratic, last 90 s) | 7.4 | 7.8 | 12.2 | 10.5 | 6.0 | 9.0 | 8.0 | 8.69 | +2.27 | 1.91 |
| 19 | Step timing (when the display ticks up) | 9.8 | 8.6 | 12.7 | 13.8 | 8.1 | 9.9 | 10.2 | 10.44 | +4.15 | 4.70 |
| 20 | Smoothed differences (naive) | 17.5 | 12.9 | 18.1 | 21.1 | 13.5 | 25.8 | 27.5 | 19.49 | +11.94 | 9.84 |
| | *Cheat: Kalman with the swing removed* | 5.8 | 5.1 | 8.5 | 6.8 | 5.1 | 5.7 | 6.0 | 6.14 | −0.09 | 2.14 |
| | *Cheat: knows the tap's true rate plan, swing and start mass* | 4.4 | 4.1 | 2.0 | 4.7 | 4.0 | 4.4 | 4.5 | 4.01 | −2.23 | 0.67 |

\* how often the fast / OK / slow status would change, with the app's 1% hysteresis. The true
rate itself changes status 1.34 times a minute under the same rule.

**Verdict: keep the Kalman filter.** It is tied for first. Only two of the 20 alternatives are
measurably better, and only by 0.02–0.05 points (about 0.3 kg/min at 600 kg/min). The
swing-model bank gains its 0.05 on noisy and near-target taps. It is slightly worse on
abrupt changes and messy taps, and costs 20 filters instead of one. Window regressions and
exponential smoothing lag more for the same noise. The particle filter and alpha-beta are
jumpier. The constant-acceleration model over-shoots changes. Where a setting stayed at the
edge of its range (IMM, self-adjusting), it was heading towards a single, plain Kalman filter.

**Why nothing can do much better:** the rate is the slope of a noisy, 50 kg-stepped weight. A
slope good to ±20 kg/min needs about 30 s of readings, and the true rate wanders during that
time. Even the cheat that knows the swing exactly only gains 0.09 points. The cheat that also
knows the operator's planned rate curve (impossible live) gets 4.0%. The live filters also run
about 2% high on a slowing tap, because they lag a falling rate. The constant-acceleration
model avoids that by over-shooting instead. The after-tap smoother removes the lag.

## Side findings (not changes to the filter)

- **Average the agreeing frames in each half-second bin instead of taking their median.** The
  shipped filter's error goes from 6.30% to 6.03% on 140 test taps, about 5× the best filter
  swap. (Frames more than 2 display steps from the median are still dropped.) The median keeps
  one display update per bin and throws the other away. How much this helps on the real scale
  depends on how often its display refreshes.
- **Status hysteresis 3% instead of 1%:** status changes drop from 2.75 to 1.18 a minute.
  Agreement with the true band is unchanged (84.4% → 84.7%). A dwell time instead (status must
  hold 3 s) cuts flicker further but costs agreement (83.3%).
- **An "I just changed the vacuum" button** (the filter widens its rate uncertainty when
  pressed) halves the time to show half of an abrupt change: 13.3 s → 6.4 s. On abrupt-change
  taps the error drops from 8.6% to 7.2%. This only works if it is pressed within about 2 s of
  the change. At 5 s late the gain is mostly gone.

## Files

- `harness.mjs`: the kinds of tap, the realistic swing, the engine capture and the scoring.
- `estimators.mjs`: the 20 candidates and the two cheat references, with the settings tried.
- `run.mjs`: tunes, tests and prints the table. It runs one worker per CPU core.
