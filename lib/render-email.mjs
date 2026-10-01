// Renders a run model (lib/model.mjs) as the email report (self-contained HTML) and as Markdown
// (GitHub job summary / tracking issue). Pure functions: the dashboard uses the same code for its
// "email preview", so what is mailed is exactly what the dashboard shows.
import {
  METRICS, PERF_METRICS, SEVERITY_LABELS, SEVERITY_RANK, categoryLabel, metricsByUrl,
} from './model.mjs';

export const GRADE_COLORS = { 'A+': '#0b8043', A: '#1e8e3e', B: '#5f8f1f', C: '#b06000', D: '#c5491d', F: '#c5221f', '—': '#6b7280' };
export const SEVERITY_COLORS = { critical: '#a50e0e', high: '#c5491d', medium: '#a76d00', low: '#1a5fb4', info: '#5f6368' };
const ICON = { critical: '🟥', high: '🟧', medium: '🟨', low: '🟦', info: '⬜' };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:)'"])/g, '<a href="$1">$1</a>');

export function formatTime(iso, timeZone = 'Asia/Jerusalem') {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('he-IL', { timeZone, dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso.replace('T', ' ').slice(0, 16);
  }
}

export function formatMetric(name, value) {
  if (value === null || value === undefined) return '—';
  if (name === 'cls') return Number(value).toFixed(3);
  const unit = METRICS[name]?.unit ?? '';
  return `${Math.round(value).toLocaleString('en-US')}${unit ? ` ${unit}` : ''}`;
}

function diffLine(model, site) {
  if (!model.diff) return 'אין ריצה קודמת להשוואה';
  if (site && !site.hasBaseline) return 'האתר לא נבדק בריצה הקודמת: אין השוואה';
  const n = site ? site.newCount : model.diff.newCount;
  const r = site ? site.resolved.length : model.diff.resolvedCount;
  return `מאז הריצה הקודמת (${formatTime(model.diff.baselineStartedAt)}): ${n} חדשים · ${r} נפתרו`;
}

export function renderMarkdown(model, { runUrl } = {}) {
  let md = `# 🛡️ QA Monster: דוח בדיקה\n\n${formatTime(model.startedAt)} (שעון ישראל) · ריצה \`${model.runId}\`${runUrl ? ` · [פרטי הריצה](${runUrl})` : ''}\n\n`;
  md += '| אתר | אבטחה | QA | 🟥 | 🟧 | 🟨 | 🟦 | 🆕 | ✅ |\n|---|---|---|---|---|---|---|---|---|\n';
  for (const s of model.sites) {
    md += `| [${s.name}](${s.baseUrl ?? '#'}) | **${s.securityGrade}**${s.securityScore !== null ? ` (${s.securityScore})` : ''} | **${s.qaGrade}**${s.qaScore !== null ? ` (${s.qaScore})` : ''} | ${s.counts.critical} | ${s.counts.high} | ${s.counts.medium} | ${s.counts.low} | ${s.hasBaseline ? s.newCount : '—'} | ${s.hasBaseline ? s.resolved.length : '—'} |\n`;
  }
  md += `\n${diffLine(model)}\n`;
  md += model.blocking.length
    ? `\n## ⚠️ ${model.blocking.length} ממצאים חוסמים (חומרה ${SEVERITY_LABELS[model.failOn]} ומעלה)\n\n`
    : '\n## ✅ אין ממצאים חוסמים\n\n';
  for (const f of model.blocking.slice(0, 40)) {
    md += `- ${ICON[f.severity]} **[${f.site}] ${f.title}**${f.isNew ? ' 🆕' : ''}${f.url ? ` (${f.url})` : ''}`;
    if (f.fix) md += `\n  - 🔧 ${f.fix.split('\n')[0].slice(0, 200)}`;
    md += '\n';
  }
  const medium = model.findings.filter((f) => f.severity === 'medium');
  if (medium.length) {
    md += `\n<details><summary>🟨 ${medium.length} ממצאים בינוניים</summary>\n\n`;
    for (const f of medium.slice(0, 60)) md += `- [${f.site}] ${f.title}${f.isNew ? ' 🆕' : ''}${f.url ? ` (${f.url})` : ''}\n`;
    md += '\n</details>\n';
  }
  const resolved = model.diff?.resolved ?? [];
  if (resolved.length) {
    md += `\n<details><summary>✅ ${resolved.length} נפתרו מאז הריצה הקודמת</summary>\n\n`;
    for (const f of resolved.slice(0, 60)) md += `- [${f.site}] ${f.title}\n`;
    md += '\n</details>\n';
  }
  md += '\nהדוח המלא (HTML) וקובץ האירועים `events.jsonl` נמצאים ב-artifact בשם **qa-monster-events**. אפשר לפתוח אותם בדשבורד (`npm run dashboard`).\n';
  return md;
}

function siteSection(model, s) {
  const cats = s.categories
    .filter((c) => s.findings.some((f) => f.category === c.category))
    .sort((a, b) => (SEVERITY_RANK[b.maxSeverity] ?? -1) - (SEVERITY_RANK[a.maxSeverity] ?? -1));
  const perf = metricsByUrl(s.metrics);
  // Grades sit on a coloured badge (white text); severity counts stay in ink next to a coloured dot.
  const gradeTile = (label, value, sub) =>
    `<td class="tile"><div class="lbl">${label}</div><div class="badge" style="background:${GRADE_COLORS[value] ?? GRADE_COLORS['—']}">${value}</div><div class="sub">${sub}</div></td>`;
  const countTile = (sev) =>
    `<td class="tile"><div class="lbl"><span class="dot" style="background:${SEVERITY_COLORS[sev]}"></span>${SEVERITY_LABELS[sev]}</div><div class="big">${s.counts[sev]}</div></td>`;

  return `
  <section class="site">
    <h2><a href="${esc(s.baseUrl ?? '#')}">${esc(s.name)}</a></h2>
    <table class="tiles" role="presentation"><tr>
      ${gradeTile('ציון אבטחה', s.securityGrade, s.securityScore !== null ? `${s.securityScore}/100` : 'לא נבדק')}
      ${gradeTile('ציון QA', s.qaGrade, s.qaScore !== null ? `${s.qaScore}/100` : 'לא נבדק')}
      ${['critical', 'high', 'medium', 'low'].map(countTile).join('')}
    </tr></table>
    <p class="meta">${s.checksCompleted}/${s.checksTotal} בדיקות הושלמו · ${esc(diffLine(model, s))}</p>
    ${perf.length ? `
    <table class="perf"><tr><th>דף</th>${PERF_METRICS.map((m) => `<th>${esc(METRICS[m].label)}</th>`).join('')}</tr>
      ${perf.map((row) => `<tr><td class="u">${linkify(row.url)}</td>${PERF_METRICS.map((m) => {
        const v = row.values[m];
        return `<td class="${v?.over ? 'over' : ''}"><span dir="ltr">${v ? esc(formatMetric(m, v.value)) : '—'}</span></td>`;
      }).join('')}</tr>`).join('')}
    </table>` : ''}
    ${cats.map((c) => `
      <h3>${esc(c.label)} <span class="count">${c.open} ממצאים${c.newCount ? ` · ${c.newCount} חדשים` : ''}</span></h3>
      <table class="findings">
        ${s.findings.filter((f) => f.category === c.category).map((f) => `<tr>
          <td class="sev"><span class="pill" style="background:${SEVERITY_COLORS[f.severity]}">${SEVERITY_LABELS[f.severity]}</span>${f.isNew ? '<br><span class="new">חדש</span>' : ''}</td>
          <td><div class="t" dir="auto">${esc(f.title)}</div>
            ${f.url ? `<div class="u">${linkify(f.url)}</div>` : ''}
            ${f.detail ? `<pre>${linkify(f.detail)}</pre>` : ''}
            ${f.fix ? `<div class="fix" dir="auto">🔧 ${linkify(f.fix)}</div>` : ''}</td></tr>`).join('')}
      </table>`).join('')}
    ${s.resolved.length ? `
      <h3>✅ נפתרו מאז הריצה הקודמת <span class="count">${s.resolved.length}</span></h3>
      <ul class="resolved">${s.resolved.map((f) => `<li dir="auto"><span class="pill" style="background:${SEVERITY_COLORS[f.severity]}">${SEVERITY_LABELS[f.severity]}</span> ${esc(f.title)} <span class="muted">(${esc(categoryLabel(f.category))})</span></li>`).join('')}</ul>` : ''}
  </section>`;
}

export function renderEmailHtml(model, { runUrl } = {}) {
  const open = model.findings.filter((f) => f.severity !== 'info').length;
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Monster Report</title><style>
body{font-family:-apple-system,"Segoe UI",Arial,sans-serif;background:#f3f4f6;color:#1f2937;margin:0;padding:16px}
.wrap{max-width:980px;margin:auto}
header{background:#0f2742;color:#fff;border-radius:14px;padding:22px 24px;margin-bottom:18px}
header h1{margin:0 0 6px;font-size:23px} header p{margin:2px 0;color:#c7d2e0;font-size:14px} header a{color:#9cc9ff}
.verdict{display:inline-block;margin-top:8px;padding:3px 10px;border-radius:999px;font-weight:700;font-size:13px}
.site{background:#fff;border-radius:14px;padding:18px 20px;margin-bottom:18px;border:1px solid #e5e7eb}
.site h2{margin:0 0 12px;font-size:20px} .site h2 a{color:#0f2742;text-decoration:none}
.site h3{font-size:15px;margin:18px 0 4px;border-top:1px solid #eef0f3;padding-top:12px} .count{font-weight:400;color:#6b7280;font-size:13px}
.tiles{width:100%;border-collapse:separate;border-spacing:6px;margin:0 -6px}
.tile{background:#f7f8fa;border-radius:10px;padding:10px 4px;text-align:center;width:16%}
.lbl{font-size:12px;color:#4b5563}.big{font-size:28px;font-weight:800;line-height:1.2;color:#111827}.sub{font-size:12px;color:#6b7280}
.badge{display:inline-block;min-width:44px;padding:4px 8px;margin:4px 0;border-radius:10px;color:#fff;font-size:24px;font-weight:800;line-height:1.3}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-inline-end:5px;vertical-align:middle}
.meta{color:#4b5563;font-size:13px;margin:8px 0}
.perf{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0}.perf th{background:#f3f4f6;font-weight:600;padding:6px}
.perf td{padding:6px;border-top:1px solid #eef0f3;text-align:center;font-variant-numeric:tabular-nums}.perf td.over{color:#c5221f;font-weight:700}
.findings{width:100%;border-collapse:collapse}.findings td{vertical-align:top;padding:8px 6px;border-top:1px solid #f1f2f4}
.sev{width:78px}.pill{color:#fff;border-radius:999px;padding:2px 8px;font-size:12px;white-space:nowrap}
.new{display:inline-block;margin-top:4px;background:#6d28d9;color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.t{font-weight:600}.u{font-size:12px;direction:ltr;text-align:left;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-all;direction:ltr;text-align:left;background:#f7f8fa;border-radius:6px;padding:6px 8px;font-size:12px;margin:6px 0}
.fix{background:#e7f5ec;border-radius:6px;padding:6px 8px;font-size:13px;margin-top:4px}
.resolved{padding:0 18px 0 0;margin:6px 0}.resolved li{margin:4px 0;font-size:13px}.muted{color:#6b7280}
footer{text-align:center;color:#6b7280;font-size:12px;margin-top:10px;line-height:1.6}
</style></head><body><div class="wrap">
<header>
  <h1>🛡️ QA Monster: דוח אבטחה ואיכות</h1>
  <p>${esc(formatTime(model.startedAt))} (שעון ישראל) · ${model.sites.length} אתרים · ${open} ממצאים פתוחים · ריצה ${esc(model.runId)}</p>
  <p>${esc(diffLine(model))}${runUrl ? ` · <a href="${esc(runUrl)}">פרטי הריצה ב-GitHub</a>` : ''}</p>
  <span class="verdict" style="background:${model.verdict === 'fail' ? '#fde2e1;color:#a50e0e' : '#e3f4e8;color:#0b8043'}">${model.verdict === 'fail' ? `${model.blocking.length} ממצאים חוסמים` : 'אין ממצאים חוסמים'}</span>
</header>
${model.sites.map((s) => siteSection(model, s)).join('')}
<footer>ציון: מתחילים מ-100 ומורידים לפי חומרה (קריטי 30, גבוה 12, בינוני 4, נמוך 1). A+ ≥ 95 · A ≥ 85 · B ≥ 75 · C ≥ 60 · D ≥ 45 · F<br>
"חדש" ו"נפתר" מחושבים רק לבדיקות שהושלמו בשתי הריצות. הדשבורד (npm run dashboard) מציג את אותם נתונים בדיוק.</footer>
</div></body></html>`;
}

