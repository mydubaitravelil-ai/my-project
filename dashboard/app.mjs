// QA Monster dashboard. All numbers come from lib/model.mjs, the same module that builds the email
// report, so the two can never disagree. Data: runs served by scripts/dashboard.mjs (local runs and
// runs synced from GitHub Actions) plus any events.jsonl file dropped on the page.
import {
  CATEGORY_ORDER, METRICS, PERF_METRICS, SEVERITIES, SEVERITY_LABELS, buildRunModel, categoryLabel,
  describeRun, groupByRun, metricsByUrl, parseEvents, pickBaseline, trendPoint,
} from '/lib/model.mjs';
import { formatMetric, renderEmailHtml } from '/lib/render-email.mjs';

// ---------- safe templating: every interpolation is escaped unless wrapped in raw() ----------
const RAW = Symbol('raw');
const raw = (s) => ({ [RAW]: String(s) });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const show = (v) => {
  if (v === null || v === undefined || v === false) return '';
  if (Array.isArray(v)) return v.map(show).join('');
  if (typeof v === 'object' && RAW in v) return v[RAW];
  return esc(v);
};
function html(strings, ...values) {
  let out = strings[0];
  values.forEach((v, i) => { out += show(v) + strings[i + 1]; });
  return raw(out);
}
const safeUrl = (u) => {
  try {
    const x = new URL(u, location.href);
    return /^https?:$/.test(x.protocol) ? x.href : '#';
  } catch {
    return '#';
  }
};
/** Text with clickable http(s) links; everything else escaped. */
function linkify(text) {
  const parts = String(text).split(/(https?:\/\/[^\s<>"']+[^\s<>"'.,;:)])/g);
  return raw(parts.map((p, i) => (i % 2 ? `<a href="${esc(safeUrl(p))}" target="_blank" rel="noopener noreferrer">${esc(p)}</a>` : esc(p))).join(''));
}

// ---------- colour roles (CSS custom properties in styles.css) ----------
const SEV_VAR = { critical: '--critical', high: '--serious', medium: '--warning', low: '--sev-low', info: '--sev-info' };
const GRADE_VAR = { 'A+': '--good', A: '--good', B: '--warning', C: '--serious', D: '--serious', F: '--critical', '—': '--sev-info' };
const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function luminance(hex) {
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (!m) return 0.5;
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a, b) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};
/** Fill a mark with a status colour and pick ink or white for the text on it, whichever contrasts more. */
const fill = (varName) => {
  const bg = cssVar(varName);
  return `background:var(${varName});color:${contrast(bg, '#0b0b0b') >= contrast(bg, '#ffffff') ? '#0b0b0b' : '#ffffff'}`;
};

// ---------- labels & formatting ----------
const SOURCE_LABEL = { local: 'מקומית', github: 'GitHub Actions', file: 'קובץ', unknown: 'לא ידוע' };
const STATUS_LABEL = { complete: 'הושלמה', running: 'רצה עכשיו', unfinalized: 'הסתיימה, לא נסגרה', stale: 'נעצרה באמצע' };
const CHECK_STATUS = {
  passed: { icon: '✓', var: '--good', label: 'עבר' },
  blocking: { icon: '!', var: '--serious', label: 'ממצאים חוסמים' },
  failed: { icon: '✕', var: '--critical', label: 'קרסה' },
  timedOut: { icon: '⏱', var: '--critical', label: 'חרגה מזמן' },
  interrupted: { icon: '✕', var: '--critical', label: 'נקטעה' },
  skipped: { icon: '–', var: '--sev-info', label: 'דולגה' },
  running: { icon: '…', var: '--sev-low', label: 'רצה' },
};
const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' }) : '');
function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} שנ׳`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} דק׳ ${s % 60} שנ׳` : `${Math.floor(m / 60)} שע׳ ${m % 60} דק׳`;
}
const shortUrl = (u) => {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname === '/' ? '' : x.pathname}`;
  } catch {
    return u;
  }
};

// ---------- state ----------
const state = {
  runs: [], // run descriptors (describeRun + origin/dir/bytes)
  runId: null,
  view: 'overview', // 'overview' or a site name
  filters: { sev: new Set(['critical', 'high', 'medium', 'low']), category: 'all', onlyNew: false, q: '' },
  tableView: false,
  serverAvailable: false,
  pollTimer: null,
  lastModel: null,
};
const eventsCache = new Map(); // runId → { key, events }
const modelCache = new Map(); // runId → { key, model }
const charts = new Map(); // chart id → spec for pointer/keyboard handlers

const runKey = (r) => `${r.runId}|${r.lastEventAt}|${r.bytes ?? ''}|${r.status}`;
const currentRun = () => state.runs.find((r) => r.runId === state.runId) ?? state.runs[0] ?? null;

async function loadRunList() {
  const files = state.runs.filter((r) => r.origin === 'file');
  try {
    const res = await fetch('/api/runs', { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const { runs } = await res.json();
    state.serverAvailable = true;
    const serverRuns = runs.map((r) => ({ ...r, origin: 'server' }));
    const ids = new Set(serverRuns.map((r) => r.runId));
    state.runs = [...serverRuns, ...files.filter((f) => !ids.has(f.runId))];
  } catch {
    state.serverAvailable = false;
    state.runs = files;
  }
  state.runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

async function loadEvents(run) {
  const key = runKey(run);
  const cached = eventsCache.get(run.runId);
  if (cached && (cached.key === key || run.origin === 'file')) return cached.events;
  const res = await fetch(`/runs/${encodeURIComponent(run.dir)}/events.jsonl`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`events.jsonl of ${run.runId}: HTTP ${res.status}`);
  const { events } = parseEvents(await res.text());
  eventsCache.set(run.runId, { key, events });
  return events;
}

async function modelFor(run) {
  const events = await loadEvents(run);
  const info = describeRun(events);
  // Finalized runs carry their own comparison (run.end); live ones are compared with their baseline.
  const baseline = info.finalized ? null : pickBaseline(state.runs, { ...info, runId: run.runId });
  const key = `${runKey(run)}|${events.length}|${baseline ? runKey(baseline) : ''}`;
  const cached = modelCache.get(run.runId);
  if (cached?.key === key) return cached.model;
  const model = buildRunModel(events, { baselineEvents: baseline ? await loadEvents(baseline) : null });
  modelCache.set(run.runId, { key, model });
  return model;
}

/** Score history for trend charts: up to 20 runs of the same source, ending with the selected run. */
async function trendFor(run, model) {
  const runs = state.runs
    .filter((r) => r.source === run.source && r.startedAt <= run.startedAt && r.runId !== run.runId)
    .sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))
    .slice(-19);
  const points = [];
  for (const r of runs) {
    try {
      points.push(trendPoint(await modelFor(r)));
    } catch {
      /* unreadable run: skip the point */
    }
  }
  points.push(trendPoint(model));
  return points;
}

// ---------- routing ----------
function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (p.get('run')) state.runId = p.get('run');
  state.view = p.get('site') ?? 'overview';
}
function writeHash() {
  const p = new URLSearchParams();
  if (state.runId) p.set('run', state.runId);
  if (state.view !== 'overview') p.set('site', state.view);
  history.replaceState(null, '', `#${p}`);
}

// ---------- small components ----------
const sevPill = (sev) => html`<span class="pill" style="${fill(SEV_VAR[sev])}">${SEVERITY_LABELS[sev]}</span>`;
const sevChip = (sev, n) => html`<span class="chip"><span class="dot" style="background:var(${SEV_VAR[sev]})"></span>${SEVERITY_LABELS[sev]} <b>${n}</b></span>`;

function checkStatus(c) {
  const key = c.completed ? (c.status === 'passed' ? 'passed' : 'blocking') : c.status in CHECK_STATUS ? c.status : 'failed';
  const s = CHECK_STATUS[key];
  return html`<span class="status-icon"><i style="${fill(s.var)}" aria-hidden="true">${s.icon}</i>${s.label}</span>`;
}

function sparkline(values, label) {
  const pts = values.map((v, i) => ({ v, i })).filter((p) => p.v !== null && p.v !== undefined);
  if (pts.length < 2) return '';
  const W = 120;
  const H = 28;
  const pad = 4;
  const x = (i) => pad + (i / (values.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - (v / 100) * (H - 2 * pad);
  let d = '';
  let pen = false;
  values.forEach((v, i) => {
    if (v === null || v === undefined) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const last = pts[pts.length - 1];
  return html`<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${label}">
    <path d="${d}" fill="none" stroke="var(--axis)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(last.i).toFixed(1)}" cy="${y(last.v).toFixed(1)}" r="4" fill="var(--series-1)" stroke="var(--surface-2)" stroke-width="2"/>
  </svg>`;
}

function gradeTile(label, gradeValue, scoreValue, values) {
  const trend = values.filter((v) => v !== null && v !== undefined);
  return html`<div class="grade-tile">
    <div class="grade-badge" style="${fill(GRADE_VAR[gradeValue] ?? '--sev-info')}" aria-label="${label}: ${gradeValue}">${gradeValue}</div>
    <div class="grade-label">${label}</div>
    <div class="grade-score">${scoreValue === null ? html`<span class="muted">לא נבדק</span>` : html`<span>${scoreValue}/100</span>`}
      ${sparkline(values, `מגמת ${label}: ${trend.join(' → ')}`)}</div>
  </div>`;
}

function deltaLine(model, site) {
  if (!model.diff) return html`<div class="delta">אין ריצה קודמת להשוואה</div>`;
  if (!site.hasBaseline) return html`<div class="delta">האתר לא נבדק בריצה הקודמת: אין השוואה</div>`;
  return html`<div class="delta"><span>🆕 <b>${site.newCount}</b> חדשים</span><span>✅ <b>${site.resolved.length}</b> נפתרו</span>
    <span>לעומת ${fmtTime(model.diff.baselineStartedAt)}</span></div>`;
}

function coverage(site) {
  const pct = site.checksTotal ? Math.round((site.checksCompleted / site.checksTotal) * 100) : 0;
  return html`<div class="coverage small muted">${site.checksCompleted}/${site.checksTotal} בדיקות הושלמו
    <div class="meter" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}" aria-label="כיסוי בדיקות"><span style="width:${pct}%"></span></div></div>`;
}

const scoreHistory = (trend, siteName, key) => trend.map((p) => p.sites[siteName]?.[key] ?? null);

// ---------- trend chart (line, 2 series on one 0–100 axis) ----------
const SERIES = [
  { key: 'securityScore', label: 'אבטחה', color: 'var(--series-1)' },
  { key: 'qaScore', label: 'QA', color: 'var(--series-2)' },
];
const Y_TICKS = [[0, '0'], [45, 'D 45'], [60, 'C 60'], [75, 'B 75'], [85, 'A 85'], [100, '100']];

function geometry(spec) {
  const H = 250;
  const m = { l: 48, r: 76, t: 14, b: 30 };
  const { W, rows } = spec;
  const n = rows.length;
  return {
    H, m, n,
    x: (i) => m.l + (i / (n - 1)) * (W - m.l - m.r),
    y: (v) => m.t + (1 - v / 100) * (H - m.t - m.b),
  };
}

function trendSvg(spec) {
  const { W, rows } = spec;
  const { H, m, n, x, y } = geometry(spec);
  const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor((W - m.l - m.r) / 90))));
  const sameDay = fmtDate(rows[0].t) === fmtDate(rows[n - 1].t);
  const tickLabel = (t) => (sameDay ? new Date(t).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : fmtDate(t));
  const xLabels = rows.map((r, i) => ({ i, label: tickLabel(r.t) })).filter((p) => p.i % every === 0 || p.i === n - 1);
  const paths = SERIES.map((s) => {
    let d = '';
    let pen = false;
    rows.forEach((r, i) => {
      const v = r[s.key];
      if (v === null) { pen = false; return; }
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return { ...s, d };
  });
  // Direct end labels only when they don't collide; the legend always carries identity.
  const ends = SERIES.map((s) => {
    for (let i = n - 1; i >= 0; i--) if (rows[i][s.key] !== null) return { ...s, i, v: rows[i][s.key] };
    return null;
  }).filter(Boolean);
  const collide = ends.length === 2 && Math.abs(y(ends[0].v) - y(ends[1].v)) < 14;
  return html`<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" tabindex="0" aria-label="מגמת ציוני אבטחה ו-QA ב-${n} ריצות. החצים עוברים בין הריצות.">
    ${Y_TICKS.map(([v, label]) => html`<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>
      <text class="tick" x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${label}</text>`)}
    <line x1="${m.l}" x2="${W - m.r}" y1="${y(0)}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1"/>
    ${xLabels.map((p) => html`<text class="tick" x="${x(p.i)}" y="${H - 8}" text-anchor="middle">${p.label}</text>`)}
    <line class="crosshair" x1="0" x2="0" y1="${m.t}" y2="${y(0)}" stroke="var(--axis)" stroke-width="1" style="display:none"/>
    ${paths.map((p) => html`<path d="${p.d}" fill="none" stroke="${p.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`)}
    ${SERIES.map((s) => rows.map((r, i) => (r[s.key] === null ? '' : html`<circle cx="${x(i).toFixed(1)}" cy="${y(r[s.key]).toFixed(1)}" r="4" fill="${s.color}" stroke="var(--surface)" stroke-width="2"/>`)))}
    ${collide ? '' : ends.map((e) => html`<text class="end-label" x="${x(e.i) + 10}" y="${y(e.v) + 4}">${e.label} ${e.v}</text>`)}
  </svg>`;
}

function trendChart(trend, siteName) {
  const rows = trend.map((p) => ({ runId: p.runId, t: p.startedAt, securityScore: p.sites[siteName]?.securityScore ?? null, qaScore: p.sites[siteName]?.qaScore ?? null }));
  const caption = html`<figcaption><h3>מגמת ציונים</h3>
    <div class="legend">${SERIES.map((s) => html`<span><span class="key" style="background:${s.color}"></span>${s.label}</span>`)}</div>
    <button class="btn" data-action="toggle-table">${state.tableView ? 'הצגת גרף' : 'הצגת טבלה'}</button></figcaption>`;

  if (state.tableView || rows.length < 2) {
    return html`<figure class="chart card">${caption}
      ${rows.length < 2 ? html`<p class="muted small">צריך לפחות שתי ריצות כדי להציג מגמה.</p>` : ''}
      <div class="table-wrap"><table class="data"><thead><tr><th>ריצה</th>${SERIES.map((s) => html`<th class="num">${s.label}</th>`)}</tr></thead>
      <tbody>${[...rows].reverse().map((r) => html`<tr><td>${fmtTime(r.t)}</td>${SERIES.map((s) => html`<td class="num">${r[s.key] ?? '—'}</td>`)}</tr>`)}</tbody></table></div>
    </figure>`;
  }
  const id = `trend-${siteName}`;
  const spec = { W: 640, rows };
  charts.set(id, spec);
  return html`<figure class="chart card">${caption}
    <div class="chart-area" data-chart="${id}">${trendSvg(spec)}<div class="tooltip" hidden></div></div>
  </figure>`;
}

/** Redraws each chart at its container's real width (1:1 text), then wires pointer + keyboard. */
function bindCharts(root) {
  for (const area of root.querySelectorAll('[data-chart]')) {
    const spec = charts.get(area.dataset.chart);
    if (!spec) continue;
    const width = Math.max(300, Math.round(area.clientWidth));
    if (width !== spec.W) {
      spec.W = width;
      area.querySelector('svg').outerHTML = show(trendSvg(spec));
    }
    const g = geometry(spec);
    const svg = area.querySelector('svg');
    const tip = area.querySelector('.tooltip');
    const cross = svg.querySelector('.crosshair');
    let current = g.n - 1;
    const hide = () => { tip.hidden = true; cross.style.display = 'none'; };
    const showAt = (i) => {
      current = Math.max(0, Math.min(g.n - 1, i));
      const r = spec.rows[current];
      const xi = g.x(current);
      cross.setAttribute('x1', xi);
      cross.setAttribute('x2', xi);
      cross.style.display = '';
      const head = document.createElement('div');
      head.className = 'small muted';
      head.textContent = fmtTime(r.t);
      const lines = SERIES.map((s) => {
        const row = document.createElement('div');
        row.className = 'tt-row';
        const name = document.createElement('span');
        name.className = 'muted';
        const key = document.createElement('span');
        key.className = 'key';
        key.style.background = s.color;
        name.append(key, ` ${s.label}`);
        const value = document.createElement('b');
        value.textContent = r[s.key] ?? '—';
        row.append(value, name);
        return row;
      });
      tip.replaceChildren(head, ...lines);
      tip.hidden = false;
      tip.style.top = '8px';
      tip.style.left = `${xi > spec.W * 0.6 ? xi - tip.offsetWidth - 12 : xi + 12}px`;
    };
    const indexAt = (clientX) => {
      const vx = clientX - svg.getBoundingClientRect().left;
      let best = 0;
      for (let i = 1; i < g.n; i++) if (Math.abs(g.x(i) - vx) < Math.abs(g.x(best) - vx)) best = i;
      return best;
    };
    svg.addEventListener('pointermove', (e) => showAt(indexAt(e.clientX)));
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('focus', () => showAt(current));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') { showAt(current - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { showAt(current + 1); e.preventDefault(); }
      if (e.key === 'Escape') hide();
    });
  }
}

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => bindCharts(document), 150);
});

// ---------- page sections ----------
function topbar(model) {
  const run = currentRun();
  const options = state.runs.map((r) => html`<option value="${r.runId}" ${r.runId === run?.runId ? 'selected' : ''}>${fmtTime(r.startedAt)} · ${SOURCE_LABEL[r.origin === 'file' ? 'file' : r.source] ?? r.source}${r.status === 'running' ? ' · רצה' : r.verdict === 'fail' ? ` · ${r.blocking} חוסמים` : r.verdict === 'pass' ? ' · תקין' : ''}</option>`);
  return html`<header class="topbar"><div class="topbar-inner">
    <div class="brand"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="var(--accent)"/><path d="m8.5 12 2.5 2.5 4.5-5" stroke="var(--surface)" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>QA Monster</div>
    <div class="controls">
      ${state.runs.length ? html`<label class="sr-only" for="run-select">ריצה</label><select id="run-select" class="run-select" data-action="select-run">${options}</select>` : ''}
      <button class="btn" data-action="sync" ${state.serverAvailable ? '' : raw('disabled title="זמין רק דרך npm run dashboard"')}>⟳ סנכרון מ-GitHub</button>
      <label class="btn">📂 טעינת events.jsonl<input type="file" accept=".jsonl,.json,.txt" multiple hidden data-action="open-file"></label>
      ${model ? html`<button class="btn" data-action="email">✉ תצוגת מייל</button>` : ''}
      <button class="btn" data-action="theme" aria-label="ערכת צבעים">${{ light: '☀', dark: '☾' }[document.documentElement.dataset.theme] ?? '◐'}</button>
    </div>
  </div></header>`;
}

function runbar(model, run) {
  const verdict = model.verdict === 'fail'
    ? html`<span class="pill" style="${fill('--critical')}">${model.blocking.length} ממצאים חוסמים</span>`
    : html`<span class="pill" style="${fill('--good')}">אין ממצאים חוסמים</span>`;
  const total = model.checks.length;
  const done = model.checks.filter((c) => c.completed).length;
  return html`<div class="runbar">
    ${model.status === 'running' ? html`<span class="live">הריצה בעיצומה: מתעדכן אוטומטית</span>` : verdict}
    <span>${STATUS_LABEL[model.status] ?? model.status} · <strong>${fmtTime(model.startedAt)}</strong> · ${SOURCE_LABEL[run.origin === 'file' ? 'file' : model.source] ?? model.source}
      ${model.github?.url ? html` · <a href="${safeUrl(model.github.url)}" target="_blank" rel="noopener">הריצה ב-GitHub</a>` : ''}</span>
    <span>${done}/${total} בדיקות · ${fmtDuration(Date.parse(model.lastEventAt) - Date.parse(model.startedAt))}</span>
    <span>${model.diff ? html`השוואה לריצה מ-${fmtTime(model.diff.baselineStartedAt)}: <strong>${model.diff.newCount}</strong> חדשים, <strong>${model.diff.resolvedCount}</strong> נפתרו` : 'אין ריצה קודמת להשוואה'}</span>
    ${model.status === 'unfinalized' ? html`<span class="small">הריצה לא נסגרה: <code>npm run report</code> שומר את ההשוואה ובונה את דוח המייל</span>` : ''}
    ${run.hasReport ? html`<a href="/runs/${encodeURIComponent(run.dir)}/report.html" target="_blank" rel="noopener">דוח המייל שנשמר</a>` : ''}
  </div>`;
}

function tabs(model) {
  return html`<nav class="tabs" role="tablist" aria-label="בחירת אתר">
    ${model.sites.length > 1 ? html`<button class="tab" role="tab" aria-selected="${String(state.view === 'overview')}" data-action="view" data-view="overview">סקירה: כל האתרים</button>` : ''}
    ${model.sites.map((s) => html`<button class="tab" role="tab" aria-selected="${String(state.view === s.name)}" data-action="view" data-view="${s.name}">
      ${s.name}<span class="mini-grade" style="${fill(GRADE_VAR[s.securityGrade])}" aria-label="ציון אבטחה ${s.securityGrade}">${s.securityGrade}</span></button>`)}
  </nav>`;
}

function siteCard(model, site, trend) {
  return html`<article class="card">
    <div class="card-head"><h2>${site.name}</h2>${site.baseUrl ? html`<a class="small ltr" href="${safeUrl(site.baseUrl)}" target="_blank" rel="noopener">${shortUrl(site.baseUrl)}</a>` : ''}</div>
    <div class="grades">
      ${gradeTile('ציון אבטחה', site.securityGrade, site.securityScore, scoreHistory(trend, site.name, 'securityScore'))}
      ${gradeTile('ציון QA', site.qaGrade, site.qaScore, scoreHistory(trend, site.name, 'qaScore'))}
    </div>
    <div class="sev-row">${['critical', 'high', 'medium', 'low'].map((k) => sevChip(k, site.counts[k]))}</div>
    ${deltaLine(model, site)}
    ${coverage(site)}
    <div class="card-foot"><button class="btn" data-action="view" data-view="${site.name}">לפרטי האתר ←</button></div>
  </article>`;
}

function comparisonMatrix(model) {
  const cats = CATEGORY_ORDER.filter((c) => model.sites.some((s) => s.categories.some((x) => x.category === c)));
  if (!cats.length) return '';
  const cell = (site, category) => {
    const c = site.categories.find((x) => x.category === category);
    if (!c) return html`<td class="cell muted" title="לא נבדק">—</td>`;
    if (!c.open) {
      return c.completed
        ? html`<td class="cell"><span class="chip"><span class="dot" style="background:var(--good)"></span>תקין</span></td>`
        : html`<td class="cell muted">לא הושלם</td>`;
    }
    return html`<td class="cell"><button class="chip" data-action="drill" data-view="${site.name}" data-category="${category}" title="${c.open} ממצאים, החמור ביותר: ${SEVERITY_LABELS[c.maxSeverity]}">
      <span class="dot" style="background:var(${SEV_VAR[c.maxSeverity]})"></span>${SEVERITY_LABELS[c.maxSeverity]} <b>${c.open}</b>${c.newCount ? html` <span class="badge-new">${c.newCount} חדשים</span>` : ''}</button></td>`;
  };
  return html`<h2 class="section-title">השוואה בין האתרים <span class="muted">ממצאים פתוחים לפי תחום והחומרה הגבוהה ביותר. לחיצה פותחת את הממצאים</span></h2>
    <div class="table-wrap"><table class="data matrix">
      <thead><tr><th>תחום</th>${model.sites.map((s) => html`<th class="cell">${s.name}</th>`)}</tr></thead>
      <tbody>${cats.map((c) => html`<tr><th scope="row">${categoryLabel(c)}</th>${model.sites.map((s) => cell(s, c))}</tr>`)}</tbody>
    </table></div>`;
}

function blockingList(model) {
  if (!model.blocking.length) return '';
  return html`<h2 class="section-title">ממצאים חוסמים <span class="muted">${model.blocking.length} בחומרה ${SEVERITY_LABELS[model.failOn]} ומעלה</span></h2>
    <div class="findings">${model.blocking.slice(0, 12).map((f) => findingRow(f, true))}</div>
    ${model.blocking.length > 12 ? html`<p class="muted small">ועוד ${model.blocking.length - 12}: כל הממצאים מופיעים בעמוד של כל אתר.</p>` : ''}`;
}

function overview(model, trend) {
  return html`<section class="grid cards">${model.sites.map((s) => siteCard(model, s, trend))}</section>
    ${comparisonMatrix(model)}
    ${blockingList(model)}`;
}

function findingRow(f, withSite = false) {
  return html`<details class="finding"><summary>
      ${sevPill(f.severity)}
      <span class="f-title" dir="auto">${withSite ? html`<span class="muted">[${f.site}]</span> ` : ''}${f.title}${f.isNew ? html` <span class="badge-new">חדש</span>` : ''}</span>
      <span class="f-meta"><span>${categoryLabel(f.category)}</span>${f.url ? html`<span class="ltr">${shortUrl(f.url)}</span>` : ''}</span>
    </summary>
    <div class="f-body">
      ${f.url ? html`<div class="small ltr"><a href="${safeUrl(f.url)}" target="_blank" rel="noopener noreferrer">${f.url}</a></div>` : ''}
      ${f.detail ? html`<pre>${f.detail}</pre>` : ''}
      ${f.fix ? html`<div class="fix" dir="auto">🔧 ${linkify(f.fix)}</div>` : ''}
      <div class="small muted">בדיקה: <span dir="auto">${f.check}</span> · מקור: ${f.source ?? 'playwright'}</div>
    </div></details>`;
}

function filteredFindings(site) {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  return site.findings.filter((x) =>
    f.sev.has(x.severity) &&
    (f.category === 'all' || x.category === f.category) &&
    (!f.onlyNew || x.isNew) &&
    (!q || [x.title, x.url, x.detail, x.check].some((v) => String(v ?? '').toLowerCase().includes(q))));
}

function findingsList(site) {
  const list = filteredFindings(site);
  if (!list.length) return html`<div class="empty">אין ממצאים שמתאימים לסינון.</div>`;
  return html`${list.slice(0, 300).map((x) => findingRow(x))}${list.length > 300 ? html`<p class="muted small">מוצגים 300 מתוך ${list.length}. אפשר לצמצם עם הסינון.</p>` : ''}`;
}

function findingsSection(site) {
  const cats = site.categories.filter((c) => site.findings.some((f) => f.category === c.category));
  return html`<h2 class="section-title">ממצאים <span class="muted" id="findings-count">${filteredFindings(site).length} מתוך ${site.findings.length}</span></h2>
    <div class="filters" role="group" aria-label="סינון ממצאים">
      ${SEVERITIES.map((s) => html`<button class="chip" data-action="toggle-sev" data-sev="${s}" aria-pressed="${String(state.filters.sev.has(s))}">
        <span class="dot" style="background:var(${SEV_VAR[s]})"></span>${SEVERITY_LABELS[s]} <b>${site.counts[s]}</b></button>`)}
      <label class="sr-only" for="cat-filter">תחום</label>
      <select id="cat-filter" data-action="category">
        <option value="all">כל התחומים</option>
        ${cats.map((c) => html`<option value="${c.category}" ${state.filters.category === c.category ? 'selected' : ''}>${c.label} (${c.open})</option>`)}
      </select>
      <label class="check"><input type="checkbox" data-action="only-new" ${state.filters.onlyNew ? 'checked' : ''}>רק חדשים</label>
      <div class="grow"><label class="sr-only" for="q">חיפוש</label><input id="q" type="search" placeholder="חיפוש בממצאים…" value="${state.filters.q}" data-action="search"></div>
    </div>
    <div class="findings" id="findings-list">${findingsList(site)}</div>`;
}

function metricsSection(site) {
  const perf = metricsByUrl(site.metrics);
  const latest = (name) => [...site.metrics].reverse().find((m) => m.name === name);
  const total = (name) => site.metrics.filter((m) => m.name === name).reduce((s, m) => s + m.value, 0);
  const tiles = [
    ['certDaysLeft', latest('certDaysLeft')?.value],
    ['pagesCrawled', latest('pagesCrawled')?.value],
    ['a11yViolations', site.metrics.some((m) => m.name === 'a11yViolations') ? total('a11yViolations') : undefined],
    ['zapAlerts', latest('zapAlerts')?.value],
  ].filter(([, v]) => v !== undefined);
  if (!perf.length && !tiles.length) return '';
  return html`<h2 class="section-title">מדדים <span class="muted">דפים קריטיים מול התקציב שהוגדר ב-sites.json · ▲ = חריגה</span></h2>
    ${tiles.length ? html`<div class="grid cards" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr));margin-bottom:12px">
      ${tiles.map(([name, v]) => html`<div class="card"><div class="grade-label">${METRICS[name].label}</div><div class="ltr" style="font-size:24px;font-weight:650;text-align:right">${formatMetric(name, v)}</div></div>`)}</div>` : ''}
    ${perf.length ? html`<div class="table-wrap"><table class="data">
      <thead><tr><th>דף</th>${PERF_METRICS.map((m) => html`<th class="num">${METRICS[m].label}</th>`)}</tr></thead>
      <tbody>${perf.map((row) => html`<tr><td class="url-cell" title="${row.url}">${shortUrl(row.url)}</td>
        ${PERF_METRICS.map((m) => {
          const v = row.values[m];
          return html`<td class="num ${v?.over ? 'over' : ''}" title="${v?.budget !== undefined && v?.budget !== null ? `תקציב: ${formatMetric(m, v.budget)}` : ''}"><span class="ltr">${v ? formatMetric(m, v.value) : '—'}</span></td>`;
        })}</tr>`)}</tbody></table></div>` : ''}`;
}

function resolvedSection(site) {
  if (!site.resolved.length) return '';
  return html`<h2 class="section-title">✅ נפתרו מאז הריצה הקודמת <span class="muted">${site.resolved.length}</span></h2>
    <div class="table-wrap"><table class="data"><tbody>${site.resolved.map((f) => html`<tr><td style="width:90px">${sevPill(f.severity)}</td><td dir="auto">${f.title}</td><td class="muted">${categoryLabel(f.category)}</td></tr>`)}</tbody></table></div>`;
}

function checksSection(site) {
  if (!site.checks.length) return '';
  const order = (c) => (c.completed ? (c.status === 'passed' ? 2 : 1) : 0);
  const rows = [...site.checks].sort((a, b) => order(a) - order(b) || CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category));
  return html`<h2 class="section-title">בדיקות <span class="muted">${site.checksCompleted}/${site.checksTotal} הושלמו</span></h2>
    <div class="table-wrap"><table class="data">
      <thead><tr><th>תחום</th><th>בדיקה</th><th>סטטוס</th><th class="num">משך</th><th>שגיאה</th></tr></thead>
      <tbody>${rows.map((c) => html`<tr><td>${categoryLabel(c.category)}</td><td dir="auto">${c.check}</td><td>${checkStatus(c)}</td>
        <td class="num">${fmtDuration(c.durationMs)}</td><td class="small muted" dir="auto">${c.error ?? ''}</td></tr>`)}</tbody>
    </table></div>`;
}

function artifactsSection(site, run) {
  if (run.origin !== 'server' || !site.artifacts.length) return '';
  const shots = site.artifacts.filter((a) => a.kind === 'screenshot');
  const reports = site.artifacts.filter((a) => a.kind === 'zap-report');
  const href = (a) => `/runs/${encodeURIComponent(run.dir)}/${a.path.split('/').map(encodeURIComponent).join('/')}`;
  return html`<h2 class="section-title">צילומי מסך ודוחות</h2>
    ${reports.length ? html`<p>${reports.map((a) => html`<a class="btn" href="${href(a)}" target="_blank" rel="noopener">${a.label ?? 'דוח ZAP'}</a> `)}</p>` : ''}
    ${shots.length ? html`<div class="shots">${shots.map((a) => html`<figure class="shot" style="margin:0"><a href="${href(a)}" target="_blank" rel="noopener"><img src="${href(a)}" alt="${a.label ?? ''} ${a.url ?? ''}" loading="lazy"></a><div>${a.label ?? ''}</div></figure>`)}</div>` : ''}`;
}

function siteView(model, site, trend, run) {
  return html`<section class="grid" style="grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr))">
      <article class="card">
        <div class="card-head"><h2>${site.name}</h2>${site.baseUrl ? html`<a class="ltr" href="${safeUrl(site.baseUrl)}" target="_blank" rel="noopener">${shortUrl(site.baseUrl)} ↗</a>` : ''}</div>
        <div class="grades">
          ${gradeTile('ציון אבטחה', site.securityGrade, site.securityScore, scoreHistory(trend, site.name, 'securityScore'))}
          ${gradeTile('ציון QA', site.qaGrade, site.qaScore, scoreHistory(trend, site.name, 'qaScore'))}
        </div>
        <div class="sev-row">${['critical', 'high', 'medium', 'low'].map((k) => sevChip(k, site.counts[k]))}</div>
        ${deltaLine(model, site)}
        ${coverage(site)}
      </article>
      ${trendChart(trend, site.name)}
    </section>
    ${metricsSection(site)}
    ${findingsSection(site)}
    ${resolvedSection(site)}
    ${checksSection(site)}
    ${artifactsSection(site, run)}`;
}

function emptyState() {
  return html`<div class="empty" style="margin-top:40px">
    <h2 style="margin-top:0">עדיין אין ריצות להצגה</h2>
    <p>מריצים בדיקה מקומית עם <code>npm run audit</code>, והיא מופיעה כאן אוטומטית.</p>
    <p>ריצות מ-GitHub Actions: הכפתור "סנכרון מ-GitHub" (צריך <code>gh auth login</code> או <code>GITHUB_TOKEN</code>), או גרירת קובץ <code>events.jsonl</code> מה-artifact <b>qa-monster-events</b> לכאן.</p>
    ${state.serverAvailable ? '' : html`<p class="small">הדשבורד לא רץ דרך השרת המקומי. כדי לראות ריצות מקומיות: <code>npm run dashboard</code>.</p>`}
  </div>`;
}

// ---------- render ----------
async function render() {
  const app = document.getElementById('app');
  const run = currentRun();
  if (!run) {
    app.innerHTML = show(html`${topbar(null)}<main class="shell">${emptyState()}</main>`);
    return schedule();
  }
  state.runId = run.runId;
  app.classList.add('loading'); // keep the previous frame while data loads
  let model;
  let trend;
  try {
    model = await modelFor(run);
    trend = await trendFor(run, model);
  } catch (e) {
    app.classList.remove('loading');
    app.innerHTML = show(html`${topbar(null)}<main class="shell"><div class="empty">לא הצלחתי לטעון את הריצה: ${e.message}</div></main>`);
    return schedule();
  }
  if (state.view !== 'overview' && !model.sites.some((s) => s.name === state.view)) state.view = 'overview';
  if (state.view === 'overview' && model.sites.length === 1) state.view = model.sites[0].name;
  state.lastModel = model;
  charts.clear();
  const site = model.sites.find((s) => s.name === state.view);
  const scrollY = window.scrollY;
  app.innerHTML = show(html`${topbar(model)}<main class="shell">
    ${runbar(model, run)}
    ${model.sites.length ? tabs(model) : ''}
    ${!model.sites.length ? html`<div class="empty">אין בריצה הזו עדיין תוצאות.</div>` : site ? siteView(model, site, trend, run) : overview(model, trend)}
  </main>`);
  window.scrollTo(0, scrollY);
  app.classList.remove('loading');
  bindCharts(app);
  writeHash();
  schedule();
}

function updateFindingsOnly() {
  const site = state.lastModel?.sites.find((s) => s.name === state.view);
  const list = document.getElementById('findings-list');
  if (!site || !list) return;
  list.innerHTML = show(findingsList(site));
  const count = document.getElementById('findings-count');
  if (count) count.textContent = `${filteredFindings(site).length} מתוך ${site.findings.length}`;
}

// Live updates: poll fast while a run is in progress, slowly otherwise; follow new runs if watching the latest.
function schedule() {
  clearTimeout(state.pollTimer);
  if (!state.serverAvailable) return;
  const run = currentRun();
  const delay = run?.status === 'running' ? 4000 : 20000;
  state.pollTimer = setTimeout(async () => {
    const before = currentRun();
    const newestBefore = state.runs[0]?.runId;
    await loadRunList();
    let changed = false;
    if (before && before.runId === newestBefore && state.runs[0] && state.runs[0].runId !== newestBefore) {
      state.runId = state.runs[0].runId;
      toast('התחילה ריצה חדשה: עוברים אליה');
      changed = true;
    }
    const after = currentRun();
    if (!changed && after && before && runKey(after) !== runKey(before)) changed = true;
    if (changed) await render();
    else schedule();
  }, delay);
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 5000);
}

// ---------- data from files (GitHub artifact events.jsonl, or any run) ----------
async function addFiles(files) {
  let added = 0;
  for (const file of files) {
    const { events, invalid } = parseEvents(await file.text());
    if (!events.length) {
      toast(`${file.name}: לא נמצאו אירועים${invalid ? ` (${invalid} שורות לא תקינות)` : ''}`);
      continue;
    }
    for (const [runId, runEvents] of groupByRun(events)) {
      const info = describeRun(runEvents);
      const entry = { ...info, runId, origin: 'file', dir: null, bytes: file.size };
      state.runs = [...state.runs.filter((r) => r.runId !== runId), entry].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
      eventsCache.set(runId, { key: runKey(entry), events: runEvents });
      modelCache.delete(runId);
      state.runId = runId;
      added++;
    }
  }
  if (added) {
    toast(`נטענו ${added} ריצות מקובץ`);
    await render();
  }
}

// ---------- interactions ----------
document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if (action === 'view' || action === 'drill') {
    state.view = el.dataset.view;
    state.filters.category = action === 'drill' ? el.dataset.category : 'all';
    state.filters.onlyNew = false;
    await render();
    window.scrollTo({ top: 0 });
  } else if (action === 'toggle-sev') {
    const s = el.dataset.sev;
    if (state.filters.sev.has(s)) state.filters.sev.delete(s);
    else state.filters.sev.add(s);
    el.setAttribute('aria-pressed', String(state.filters.sev.has(s)));
    updateFindingsOnly();
  } else if (action === 'toggle-table') {
    state.tableView = !state.tableView;
    await render();
  } else if (action === 'email') {
    const run = currentRun();
    const model = state.lastModel;
    if (!model) return;
    const url = URL.createObjectURL(new Blob([renderEmailHtml(model, { runUrl: model.github?.url })], { type: 'text/html' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    if (run && !model.finalized) toast('הריצה עוד לא נסגרה: זה תצוגה מקדימה של המייל');
  } else if (action === 'sync') {
    el.disabled = true;
    el.textContent = 'מסנכרן…';
    try {
      const res = await fetch('/api/github/sync?limit=10', { method: 'POST', headers: { 'X-QA-Monster': '1' } });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      toast(`GitHub (${body.repo}): ${body.added.length} ריצות חדשות, ${body.skipped.length} כבר קיימות${body.failed.length ? `, ${body.failed.length} נכשלו` : ''}`);
      await loadRunList();
      if (body.added.length) state.runId = state.runs[0]?.runId;
      await render();
    } catch (err) {
      toast(`הסנכרון נכשל: ${err.message}`);
      el.disabled = false;
      el.textContent = '⟳ סנכרון מ-GitHub';
    }
  } else if (action === 'theme') {
    const next = { undefined: 'light', light: 'dark', dark: undefined }[document.documentElement.dataset.theme];
    if (next) document.documentElement.dataset.theme = next;
    else delete document.documentElement.dataset.theme;
    try {
      if (next) localStorage.setItem('qa-monster-theme', next);
      else localStorage.removeItem('qa-monster-theme');
    } catch { /* storage unavailable */ }
    await render();
  }
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const action = el.dataset?.action;
  if (action === 'select-run') {
    state.runId = el.value;
    await render();
  } else if (action === 'category') {
    state.filters.category = el.value;
    updateFindingsOnly();
  } else if (action === 'only-new') {
    state.filters.onlyNew = el.checked;
    updateFindingsOnly();
  } else if (action === 'open-file') {
    await addFiles([...el.files]);
    el.value = '';
  }
});

document.addEventListener('input', (e) => {
  if (e.target.dataset?.action === 'search') {
    state.filters.q = e.target.value;
    updateFindingsOnly();
  }
});

let dragDepth = 0;
let dropzone = null;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  dragDepth++;
  if (!dropzone) {
    dropzone = document.createElement('div');
    dropzone.className = 'dropzone';
    dropzone.textContent = 'שחררו כאן קובץ events.jsonl';
    document.body.append(dropzone);
  }
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; dropzone?.remove(); dropzone = null; }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone?.remove();
  dropzone = null;
  if (e.dataTransfer?.files?.length) await addFiles([...e.dataTransfer.files]);
});
window.addEventListener('hashchange', () => {
  readHash();
  render();
});

// ---------- boot ----------
try {
  const theme = localStorage.getItem('qa-monster-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch { /* storage unavailable */ }
readHash();
await loadRunList();
await render();
