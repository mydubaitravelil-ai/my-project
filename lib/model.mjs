// QA Monster model: turns the events of a run (events.jsonl) into everything people see —
// findings, A–F grades, coverage, metrics and the "new vs resolved" comparison with the previous run.
//
// Pure functions only (no Node or browser APIs). The email report (scripts/build-report.mjs) and the
// dashboard (dashboard/app.mjs) both import this file, so they can never show two versions of the truth.

export const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
export const SEVERITY_RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
export const SEVERITY_LABELS = { critical: 'קריטי', high: 'גבוה', medium: 'בינוני', low: 'נמוך', info: 'מידע' };

/** Points removed per finding; each (category, severity) pair counts at most PENALTY_CAP times. */
export const PENALTY = { critical: 30, high: 12, medium: 4, low: 1, info: 0 };
export const PENALTY_CAP = { critical: 3, high: 3, medium: 3, low: 6, info: 0 };
export const GRADES = [['A+', 95], ['A', 85], ['B', 75], ['C', 60], ['D', 45], ['F', 0]];

export const SECURITY_CATEGORIES = ['transport', 'headers', 'exposure', 'zap'];
export const CATEGORY_ORDER = [
  'availability', 'links', 'performance', 'responsive', 'seo', 'accessibility', 'forms', 'flows',
  'transport', 'headers', 'exposure', 'zap', 'runner',
];
export const CATEGORY_LABELS = {
  availability: 'זמינות',
  links: 'קישורים',
  performance: 'ביצועים',
  responsive: 'מובייל ותצוגה',
  seo: 'SEO',
  accessibility: 'נגישות',
  forms: 'טפסים',
  flows: 'זרימות משתמש',
  transport: 'הצפנה (TLS/HTTPS)',
  headers: 'Headers ועוגיות',
  exposure: 'קבצים חשופים',
  zap: 'OWASP ZAP',
  runner: 'כיסוי וריצה',
};

export const METRICS = {
  ttfb: { label: 'TTFB', unit: 'ms' },
  fcp: { label: 'FCP', unit: 'ms' },
  lcp: { label: 'LCP', unit: 'ms' },
  cls: { label: 'CLS', unit: '' },
  requests: { label: 'בקשות', unit: '' },
  pageWeightKb: { label: 'משקל דף', unit: 'KB' },
  loadMs: { label: 'זמן טעינה', unit: 'ms' },
  serverResponseMs: { label: 'תגובת שרת', unit: 'ms' },
  certDaysLeft: { label: 'ימים לתוקף SSL', unit: '' },
  pagesCrawled: { label: 'דפים שנסרקו', unit: '' },
  a11yViolations: { label: 'הפרות נגישות', unit: '' },
  zapAlerts: { label: 'התראות ZAP', unit: '' },
};
export const PERF_METRICS = ['loadMs', 'ttfb', 'fcp', 'lcp', 'cls', 'pageWeightKb', 'requests'];

/** A run with no new event for this long, and no end marker, was killed. */
export const STALE_AFTER_MS = 20 * 60_000;

export const isSecurityCategory = (category) => SECURITY_CATEGORIES.includes(category);
export const checkKey = (x) => `${x.site}|${x.category}|${x.check}`;
export const categoryLabel = (c) => CATEGORY_LABELS[c] ?? c;

export function grade(score) {
  if (score === null || score === undefined) return '—';
  for (const [g, min] of GRADES) if (score >= min) return g;
  return 'F';
}

export function score(findings) {
  const buckets = new Map();
  for (const f of findings) {
    if (!PENALTY[f.severity]) continue;
    const k = `${f.category}\u0000${f.severity}`;
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  }
  let s = 100;
  for (const [k, n] of buckets) {
    const severity = k.split('\u0000')[1];
    s -= PENALTY[severity] * Math.min(n, PENALTY_CAP[severity]);
  }
  return Math.max(0, s);
}

export function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) if (f.severity in counts) counts[f.severity]++;
  return counts;
}

/** Parses JSON Lines; malformed lines are counted, not fatal. */
export function parseEvents(text) {
  const events = [];
  let invalid = 0;
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t);
      if (e && typeof e === 'object' && typeof e.type === 'string') events.push(e);
      else invalid++;
    } catch {
      invalid++;
    }
  }
  return { events, invalid };
}

const byTime = (a, b) =>
  (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0) || (a.pid ?? 0) - (b.pid ?? 0) || (a.seq ?? 0) - (b.seq ?? 0);

export function sortEvents(events) {
  return [...events].sort(byTime);
}

/** Splits events that belong to several runs (e.g. a dropped file with many runs) by runId. */
export function groupByRun(events) {
  const runs = new Map();
  for (const e of events) {
    const id = e.runId ?? 'unknown';
    if (!runs.has(id)) runs.set(id, []);
    runs.get(id).push(e);
  }
  return runs;
}

/** Lightweight description of a run, enough for run lists and baseline selection. */
export function describeRun(events, { now = Date.now() } = {}) {
  let start = null;
  let end = null;
  let phase = false;
  let first = null;
  let lastAt = null;
  for (const e of events) {
    if (e.type === 'run.start' && (!start || e.ts < start.ts)) start = e;
    if (e.type === 'run.end' && (!end || e.ts >= end.ts)) end = e;
    if (e.type === 'run.phase') phase = true;
    if (!first || e.ts < first) first = e.ts;
    if (!lastAt || e.ts > lastAt) lastAt = e.ts;
  }
  let status = end ? 'complete' : phase ? 'unfinalized' : 'running';
  if (status === 'running' && lastAt && now - Date.parse(lastAt) > STALE_AFTER_MS) status = 'stale';
  return {
    runId: start?.runId ?? events[0]?.runId ?? null,
    source: start?.source ?? 'unknown',
    startedAt: start?.ts ?? first,
    lastEventAt: lastAt,
    finalized: !!end,
    status,
    verdict: end?.status ?? null,
    blocking: end?.blocking ?? null,
    sites: (start?.sites ?? []).map((s) => s.name),
    github: start?.github ?? null,
    git: start?.git ?? null,
  };
}

/** The run another run is compared with: the latest earlier finalized run from the same source. */
export function pickBaseline(runs, current) {
  return (
    runs
      .filter((r) => r.runId !== current.runId && r.finalized && r.source === current.source && r.startedAt < current.startedAt)
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0] ?? null
  );
}

const slim = (f) => ({ fp: f.fp, site: f.site, category: f.category, check: f.check, severity: f.severity, title: f.title, url: f.url });

/** Checks, deduplicated findings, metrics and artifacts of one run — before any comparison. */
export function buildCore(rawEvents, { now } = {}) {
  const events = sortEvents(rawEvents);
  const info = describeRun(events, { now });
  const start = events.find((e) => e.type === 'run.start') ?? null;
  const end = [...events].reverse().find((e) => e.type === 'run.end') ?? null;
  const ended = info.status !== 'running';

  const checks = new Map();
  for (const e of events) {
    if (e.type === 'check.start') {
      checks.set(checkKey(e), { key: checkKey(e), site: e.site, category: e.category, check: e.check, status: 'running', completed: false, startedAt: e.ts });
    } else if (e.type === 'check.end') {
      const k = checkKey(e);
      const c = checks.get(k) ?? { key: k, site: e.site, category: e.category, check: e.check, startedAt: e.ts };
      Object.assign(c, { status: e.status ?? 'unknown', completed: e.completed === true, durationMs: e.durationMs ?? null, error: e.error ?? null, endedAt: e.ts });
      checks.set(k, c);
    }
  }
  if (ended) {
    for (const c of checks.values()) {
      if (c.status === 'running') Object.assign(c, { status: 'interrupted', error: 'No end event: the worker crashed or the job was cancelled' });
    }
  }

  const byFp = new Map();
  for (const e of events) {
    if (e.type !== 'finding' || !(e.severity in SEVERITY_RANK) || !e.fp) continue;
    const prev = byFp.get(e.fp);
    if (!prev || SEVERITY_RANK[e.severity] > SEVERITY_RANK[prev.severity]) {
      byFp.set(e.fp, {
        fp: e.fp, site: e.site, category: e.category, check: e.check, severity: e.severity,
        title: e.title, url: e.url, detail: e.detail, fix: e.fix, source: e.source ?? 'playwright',
      });
    }
  }
  const findings = [...byFp.values()];
  for (const c of checks.values()) {
    if (c.completed || c.status === 'running' || c.status === 'skipped') continue;
    findings.push({
      fp: `incomplete:${c.key}`, site: c.site, category: c.category, check: c.check, severity: 'medium',
      title: `Check could not complete: ${c.check} (${c.status})`, detail: c.error ?? undefined,
      fix: 'Re-run the audit; if it keeps failing, open the Playwright report / trace of this check.',
      source: 'runner', synthetic: true,
    });
  }

  const pick = (type, fields) =>
    events.filter((e) => e.type === type).map((e) => Object.fromEntries(['site', 'category', 'check', 'ts', ...fields].map((k) => [k, e[k]])));

  const siteMeta = new Map((start?.sites ?? []).map((s) => [s.name, s]));
  const siteNames = [...new Set([...siteMeta.keys(), ...[...checks.values()].map((c) => c.site), ...findings.map((f) => f.site)])].filter(Boolean);

  return {
    info,
    start,
    end,
    ended,
    failOn: end?.failOn ?? start?.failOn ?? 'high',
    checks: [...checks.values()],
    findings,
    metrics: pick('metric', ['name', 'value', 'unit', 'url', 'budget']),
    artifacts: pick('artifact', ['kind', 'path', 'label', 'url', 'bytes']),
    warnings: events.filter((e) => e.type === 'log' && (e.level === 'warn' || e.level === 'error')).map((e) => ({ site: e.site, category: e.category, level: e.level, message: e.message, ts: e.ts })),
    siteMeta,
    siteNames,
  };
}

/**
 * New = present now, absent last time, and its check completed last time (otherwise there is no
 * baseline for it). Resolved = present last time, absent now, and its check completed now — a check
 * that did not run (site filter, ZAP skipped, crash) never "resolves" anything.
 */
export function computeDiff(cur, base) {
  const completedKeys = (core) => new Set(core.checks.filter((c) => c.completed).map((c) => c.key));
  const prevDone = completedKeys(base);
  const curDone = completedKeys(cur);
  const prevFps = new Set(base.findings.map((f) => f.fp));
  const curFps = new Set(cur.findings.map((f) => f.fp));
  const tracked = (f) => f.severity !== 'info';
  return {
    baselineRunId: base.info.runId,
    baselineStartedAt: base.info.startedAt,
    baselineSites: [...new Set(base.checks.filter((c) => c.completed).map((c) => c.site))],
    new: cur.findings.filter((f) => tracked(f) && prevDone.has(checkKey(f)) && !prevFps.has(f.fp)).map((f) => f.fp),
    resolved: base.findings.filter((f) => tracked(f) && curDone.has(checkKey(f)) && !curFps.has(f.fp)).map(slim),
  };
}

const bySeverity = (a, b) =>
  SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
  Number(!!b.isNew) - Number(!!a.isNew) ||
  CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
  String(a.title).localeCompare(String(b.title));

/** Latest value per (url, metric) for a site, for performance tables. */
export function metricsByUrl(metrics, names = PERF_METRICS) {
  const rows = new Map();
  for (const m of metrics) {
    if (!names.includes(m.name) || !m.url) continue;
    if (!rows.has(m.url)) rows.set(m.url, { url: m.url, values: {} });
    rows.get(m.url).values[m.name] = { value: m.value, unit: m.unit, budget: m.budget, over: m.budget !== undefined && m.budget !== null && m.value > m.budget };
  }
  return [...rows.values()];
}

function buildSite(name, core, findings, diff) {
  const checks = core.checks.filter((c) => c.site === name);
  const completed = checks.filter((c) => c.completed);
  const list = findings.filter((f) => f.site === name);
  const securityDone = completed.some((c) => isSecurityCategory(c.category));
  const qaDone = completed.some((c) => !isSecurityCategory(c.category));
  const coverageGap = (group, title) => list.push({
    fp: `not-checked:${name}:${group}`, site: name, category: 'runner', check: 'coverage', severity: 'high',
    title, source: 'runner', synthetic: true, isNew: false,
  });
  if (core.ended) {
    const expected = core.start?.expect ?? null;
    if (!completed.length) coverageGap('all', 'Site was not checked: no check completed in this run');
    else if (expected?.includes('qa') && !qaDone) coverageGap('qa', 'QA checks did not run for this site');
    else if (expected?.includes('security') && !securityDone) coverageGap('security', 'Security checks did not run for this site');
  }
  list.sort(bySeverity);

  const securityScore = securityDone ? score(list.filter((f) => isSecurityCategory(f.category))) : null;
  const qaScore = qaDone ? score(list.filter((f) => !isSecurityCategory(f.category))) : null;

  const categories = CATEGORY_ORDER.map((category) => {
    const cf = list.filter((f) => f.category === category);
    const cc = checks.filter((c) => c.category === category);
    if (!cf.length && !cc.length) return null;
    const open = cf.filter((f) => f.severity !== 'info');
    return {
      category,
      label: categoryLabel(category),
      security: isSecurityCategory(category),
      open: open.length,
      counts: countBySeverity(cf),
      maxSeverity: open.reduce((m, f) => (!m || SEVERITY_RANK[f.severity] > SEVERITY_RANK[m] ? f.severity : m), null),
      newCount: cf.filter((f) => f.isNew).length,
      checks: cc.length,
      completed: cc.filter((c) => c.completed).length,
    };
  }).filter(Boolean);

  const resolved = (diff?.resolved ?? []).filter((r) => r.site === name);
  return {
    name,
    baseUrl: core.siteMeta.get(name)?.baseUrl ?? null,
    securityScore,
    securityGrade: grade(securityScore),
    qaScore,
    qaGrade: grade(qaScore),
    counts: countBySeverity(list),
    open: list.filter((f) => f.severity !== 'info').length,
    findings: list,
    newCount: list.filter((f) => f.isNew).length,
    resolved,
    hasBaseline: !!diff && (diff.baselineSites ?? []).includes(name),
    checks,
    checksTotal: checks.length,
    checksCompleted: completed.length,
    categories,
    metrics: core.metrics.filter((m) => m.site === name),
    artifacts: core.artifacts.filter((a) => a.site === name),
  };
}

/**
 * Full model of a run. The comparison comes from the run's own run.end event once the run is finalized
 * (so every reader sees exactly what the email showed); before that it is computed against
 * `baselineEvents`. `recomputeDiff` forces a fresh comparison (used when finalizing).
 */
export function buildRunModel(events, { baselineEvents = null, recomputeDiff = false, now } = {}) {
  const core = buildCore(events, { now });
  let diff = null;
  if (baselineEvents?.length && (recomputeDiff || !core.end?.diff)) diff = computeDiff(core, buildCore(baselineEvents, { now }));
  else if (core.end?.diff) diff = core.end.diff;

  const newFps = new Set(diff?.new ?? []);
  const findings = core.findings.map((f) => ({ ...f, isNew: newFps.has(f.fp) }));
  const sites = core.siteNames.map((name) => buildSite(name, core, findings, diff));
  const all = sites.flatMap((s) => s.findings).sort(bySeverity);
  const blocking = all.filter((f) => SEVERITY_RANK[f.severity] >= (SEVERITY_RANK[core.failOn] ?? 3));

  return {
    ...core.info,
    failOn: core.failOn,
    sites,
    findings: all,
    blocking,
    verdict: blocking.length ? 'fail' : 'pass',
    diff: diff && {
      baselineRunId: diff.baselineRunId ?? null,
      baselineStartedAt: diff.baselineStartedAt ?? null,
      baselineSites: diff.baselineSites ?? [],
      newCount: all.filter((f) => f.isNew).length,
      resolvedCount: (diff.resolved ?? []).length,
      new: [...newFps],
      resolved: diff.resolved ?? [],
    },
    checks: core.checks,
    metrics: core.metrics,
    artifacts: core.artifacts,
    warnings: core.warnings,
  };
}

/** Per-site scores of a run, for trend charts. */
export function trendPoint(model) {
  return {
    runId: model.runId,
    startedAt: model.startedAt,
    sites: Object.fromEntries(model.sites.map((s) => [s.name, { securityScore: s.securityScore, qaScore: s.qaScore, open: s.open, counts: s.counts }])),
  };
}

/** The run.end event a finalized run carries: verdict plus the comparison every reader will reuse. */
export function runEndPayload(model) {
  return {
    status: model.verdict,
    failOn: model.failOn,
    blocking: model.blocking.length,
    diff: model.diff && {
      baselineRunId: model.diff.baselineRunId,
      baselineStartedAt: model.diff.baselineStartedAt,
      baselineSites: model.diff.baselineSites,
      new: model.diff.new,
      resolved: model.diff.resolved,
    },
  };
}
