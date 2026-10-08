// CSV / JSON export and sharing (iOS share sheet: AirDrop, Mail, Files, ...).

const FLAG_NAMES = ['pre', 'ok', 'slow', 'touch', 'spike'];
const STATUS_NAMES = ['no-flow', 'measuring', 'on-target', 'too-fast', 'too-slow', 'flow-dropping'];

const esc = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const iso = (ms) => new Date(ms).toISOString();
const local = (ms) => {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export function sessionFileBase(sess) {
  const pots = (sess.meta?.pots || '').replace(/[^0-9A-Za-z]+/g, '-').replace(/^-|-$/g, '');
  return `tap_${local(sess.wall0).replace(/[: ]/g, '').replace(/-/g, '')}${pots ? '_pot' + pots : ''}`;
}

function metaLines(sess) {
  const m = sess.meta || {};
  const a = sess.analysis?.totals || {};
  const lines = [
    `# Tap Rate export`,
    `# session,${esc(sess.id)}`,
    `# started,${local(sess.wall0)}`,
    `# source,${esc(sess.source || 'camera')}`,
    `# pots,${esc(m.pots)}`,
    `# crucible,${esc(m.crucible)}`,
    `# crew,${esc(m.crew)}`,
    `# operator,${esc(m.operator)}`,
    `# notes,${esc(m.notes)}`,
    `# target_kg_min,${sess.config?.targetKgMin},tolerance_pct,${sess.config?.tolPct}`,
    `# total_mass_kg,${a.massKg ?? ''},avg_kg_min,${a.avgKgMin ?? ''},taps,${a.taps ?? ''},touches,${a.touches ?? ''},noise_sigma_kg,${a.noiseSigma ?? ''}`,
  ];
  (sess.analysis?.segments || []).forEach((s, i) => {
    lines.push(`# tap_${i + 1},start_s,${s.onset},end_s,${s.end},duration_s,${s.duration},mass_kg,${s.massKg},avg_kg_min,${s.avgKgMin},ci90,${s.ciKgMin},peak60_kg_min,${s.peak60KgMin ?? ''},pct_fast,${s.pctFast ?? ''},pct_ok,${s.pctOk ?? ''},pct_slow,${s.pctSlow ?? ''},touches,${s.touches}`);
  });
  return lines;
}

// the after-tap rate curve at time t (linear between its 1 s points, blank in its gaps)
function curveAt(sm, t) {
  const n = sm?.t?.length || 0;
  if (n < 2) return null;
  let lo = 0, hi = n;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (sm.t[mid] < t) lo = mid + 1; else hi = mid; }
  const i = Math.min(Math.max(lo, 1), n - 1);
  const t0 = sm.t[i - 1], t1 = sm.t[i];
  if (t < t0 - 0.5 || t > t1 + 0.5 || t1 - t0 > 1.5) return null;
  const u = Math.min(1, Math.max(0, (t - t0) / (t1 - t0)));
  return { rate: sm.rate[i - 1] + u * (sm.rate[i] - sm.rate[i - 1]), ci: sm.ci[i - 1] + u * (sm.ci[i] - sm.ci[i - 1]) };
}

/** One row per 0.5 s measurement (median of the camera frames in that half second). */
export function sessionCSV(sess) {
  const w = sess.config?.windows || [20, 40, 60, 120];
  const head = ['time_s', 'clock', 'reading_kg', 'frames', 'flag', 'kalman_mass_kg', 'kalman_rate_kg_min', 'kalman_rate_ci90', ...w.map((x) => `rate_${x}s_kg_min`), 'level_10s_kg', 'status', 'smoothed_rate_kg_min', 'smoothed_rate_ci90'];
  const rows = [...metaLines(sess), head.join(',')];
  for (const r of sess.meas || []) {
    const c = curveAt(sess.analysis?.smooth, r.t);
    rows.push([
      r.t, local(sess.wall0 + r.t * 1000), r.z, r.n, FLAG_NAMES[r.f] ?? r.f,
      r.m ?? '', r.q != null ? Math.round(r.q * 600) / 10 : '', r.qs != null ? Math.round(r.qs * 60 * 1.645) : '',
      ...w.map((x) => r['r' + x] ?? ''), r.L ?? '', r.st != null ? STATUS_NAMES[r.st] : '',
      c ? Math.round(c.rate * 10) / 10 : '', c ? Math.round(c.ci) : '',
    ].map(esc).join(','));
  }
  return rows.join('\n') + '\n';
}

/** Every processed camera frame. */
export function rawCSV(sess) {
  const rows = [...metaLines(sess), 'time_s,clock,reading_kg,confidence,decision'];
  for (const [t, v, c, how] of sess.raw || []) rows.push([t, iso(sess.wall0 + t * 1000), v ?? '', c, how ?? ''].join(','));
  return rows.join('\n') + '\n';
}

/** One row per tap across sessions. */
export function summaryCSV(sessions) {
  const head = ['session', 'date', 'source', 'pots', 'crucible', 'crew', 'operator', 'tap', 'start', 'end', 'duration_s', 'level_before_kg', 'level_after_kg', 'mass_kg', 'avg_kg_min', 'ci90_kg_min', 'verdict', 'peak60_kg_min', 'pct_fast', 'pct_ok', 'pct_slow', 'touches', 'target_kg_min', 'notes'];
  const rows = [head.join(',')];
  for (const s of sessions) {
    const m = s.meta || {};
    const segs = s.analysis?.segments || [];
    segs.forEach((g, i) => {
      rows.push([
        s.id, local(s.wall0).slice(0, 10), s.source || 'camera', m.pots, m.crucible, m.crew, m.operator, i + 1,
        local(s.wall0 + g.onset * 1000).slice(11), local(s.wall0 + g.end * 1000).slice(11), g.duration,
        g.levelBefore, g.levelAfter, g.massKg, g.avgKgMin, g.ciKgMin, g.verdict, g.peak60KgMin ?? '',
        g.pctFast ?? '', g.pctOk ?? '', g.pctSlow ?? '', g.touches, s.config?.targetKgMin, m.notes,
      ].map(esc).join(','));
    });
  }
  return rows.join('\n') + '\n';
}

export async function shareOrDownload(filename, text, mime = 'text/csv') {
  const blob = new Blob([text], { type: mime });
  const file = typeof File === 'function' ? new File([blob], filename, { type: mime }) : null;
  if (file && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}
