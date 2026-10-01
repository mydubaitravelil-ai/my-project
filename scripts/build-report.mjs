#!/usr/bin/env node
// Aggregates Playwright findings + OWASP ZAP results into a graded HTML report,
// a Markdown summary (GitHub job summary / issue body) and summary.json (history).
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const REPORTS = path.join(ROOT, 'reports');
const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const PENALTY = { critical: 30, high: 12, medium: 4, low: 1, info: 0 };
const SECURITY_CATEGORIES = new Set(['transport', 'headers', 'exposure', 'zap']);
const SEV_HE = { critical: 'קריטי', high: 'גבוה', medium: 'בינוני', low: 'נמוך', info: 'מידע' };
const CAT_HE = {
  availability: 'זמינות', links: 'קישורים', seo: 'SEO', accessibility: 'נגישות', performance: 'ביצועים',
  responsive: 'מובייל ותצוגה', forms: 'טפסים', transport: 'הצפנה (TLS/HTTPS)', headers: 'Headers ועוגיות',
  exposure: 'קבצים חשופים', zap: 'OWASP ZAP', home: 'זרימות משתמש', runner: 'שגיאות ריצה',
};

const failOn = process.env.FAIL_ON ?? 'high';
const sites = JSON.parse(fs.readFileSync(process.env.SITES_FILE ?? path.join(ROOT, 'sites.json'), 'utf8')).sites;

const walk = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)])) : []);

// 1. Playwright findings
const findings = [];
const checked = new Set();
for (const f of walk(REPORTS).filter((f) => /[\\/]findings[\\/].*\.json$/.test(f))) {
  const data = JSON.parse(fs.readFileSync(f, 'utf8'));
  checked.add(data.site);
  findings.push(...data.findings);
}

// 2. Tests that crashed (not just "blocking findings") become findings too.
for (const f of walk(REPORTS).filter((f) => f.endsWith('playwright-results.json'))) {
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) for (const t of spec.tests ?? []) {
      const last = t.results?.at(-1);
      if (!last || !['failed', 'timedOut', 'interrupted'].includes(last.status)) continue;
      const msg = (last.error?.message ?? last.status).replace(/\u001b\[[0-9;]*m/g, '');
      if (/blocking finding\(s\)/.test(msg)) continue;
      findings.push({ site: t.projectName, category: path.basename(spec.file ?? suite.file ?? 'runner').replace(/\.spec\.ts$/, ''), check: spec.title,
        severity: 'medium', title: `Check could not complete: ${spec.title} (${last.status})`, detail: msg.slice(0, 600) });
    }
    (suite.suites ?? []).forEach(visit);
  };
  (JSON.parse(fs.readFileSync(f, 'utf8')).suites ?? []).forEach(visit);
}

// 3. OWASP ZAP (reports/zap/zap-<site>/report_json.json)
const ZAP_RISK = { 3: 'high', 2: 'medium', 1: 'low', 0: 'info' };
for (const f of walk(path.join(REPORTS, 'zap')).filter((f) => f.endsWith('report_json.json'))) {
  const siteName = path.basename(path.dirname(f)).replace(/^zap-/, '');
  const zap = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const s of zap.site ?? []) for (const a of s.alerts ?? []) {
    const strip = (h) => (h ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    findings.push({
      site: siteName, category: 'zap', check: `ZAP ${a.pluginid}`, severity: ZAP_RISK[a.riskcode] ?? 'info',
      title: `${a.name} (${a.count ?? a.instances?.length ?? 1}×)`, url: a.instances?.[0]?.uri,
      detail: [strip(a.desc).slice(0, 400), ...(a.instances ?? []).slice(0, 5).map((i) => `${i.method ?? ''} ${i.uri} ${i.param ?? ''}`.trim())].join('\n'),
      fix: strip(a.solution).slice(0, 500),
    });
  }
}

// 4. Diff against previous run
const keyOf = (f) => `${f.site}|${f.category}|${f.title}|${f.url ?? ''}`;
const prevFile = path.join(REPORTS, 'previous', 'summary.json');
const prev = fs.existsSync(prevFile) ? JSON.parse(fs.readFileSync(prevFile, 'utf8')) : null;
const prevKeys = new Set((prev?.findings ?? []).filter((f) => f.severity !== 'info').map(keyOf));
for (const f of findings) f.isNew = !!prev && f.severity !== 'info' && !prevKeys.has(keyOf(f));
const curKeys = new Set(findings.map(keyOf));
const resolved = (prev?.findings ?? []).filter((f) => f.severity !== 'info' && !curKeys.has(keyOf(f)));

// 5. Scores
const grade = (s) => (s >= 95 ? 'A+' : s >= 85 ? 'A' : s >= 75 ? 'B' : s >= 60 ? 'C' : s >= 45 ? 'D' : 'F');
const score = (list) => {
  // Cap repeated penalties per (category, severity) so one noisy check can't zero a score.
  const buckets = {};
  for (const f of list) { const k = `${f.category}|${f.severity}`; buckets[k] = (buckets[k] ?? 0) + 1; }
  let s = 100;
  for (const [k, n] of Object.entries(buckets)) { const sev = k.split('|')[1]; s -= PENALTY[sev] * Math.min(n, sev === 'low' ? 6 : 3); }
  return Math.max(0, s);
};
const count = (list) => Object.fromEntries(Object.keys(RANK).map((s) => [s, list.filter((f) => f.severity === s).length]));

const perSite = sites.map((site) => {
  const list = findings.filter((f) => f.site === site.name).sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  const sec = list.filter((f) => SECURITY_CATEGORIES.has(f.category));
  const qa = list.filter((f) => !SECURITY_CATEGORIES.has(f.category));
  const securityScore = score(sec), qaScore = score(qa);
  return { name: site.name, baseUrl: site.baseUrl, checked: checked.has(site.name), findings: list, counts: count(list), securityScore, securityGrade: grade(securityScore), qaScore, qaGrade: grade(qaScore), zapRan: list.some((f) => f.category === 'zap') || fs.existsSync(path.join(REPORTS, 'zap', `zap-${site.name}`)) };
});
for (const s of perSite) if (!s.checked) {
  s.securityGrade = s.qaGrade = '—';
  const f = { site: s.name, category: 'runner', check: 'coverage', severity: 'high', title: 'Site was not checked — no test results were produced' };
  findings.push(f); s.findings.push(f); s.counts.high++;
}
const blocking = findings.filter((f) => RANK[f.severity] >= RANK[failOn]);
const generatedAt = new Date().toISOString();
const runUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : '';

fs.mkdirSync(REPORTS, { recursive: true });
fs.writeFileSync(path.join(REPORTS, 'summary.json'), JSON.stringify({ generatedAt, failOn, blocking: blocking.length, sites: perSite.map(({ findings, ...s }) => s), findings }, null, 2));

// 6. Markdown
const icon = { critical: '🟥', high: '🟧', medium: '🟨', low: '🟦', info: '⬜' };
let md = `# 🛡️ QA Monster — דוח בדיקה\n\n${generatedAt.replace('T', ' ').slice(0, 16)} UTC${runUrl ? ` · [ריצה מלאה](${runUrl})` : ''}\n\n`;
md += `| אתר | ציון אבטחה | ציון QA | 🟥 | 🟧 | 🟨 | 🟦 |\n|---|---|---|---|---|---|---|\n`;
for (const s of perSite) md += `| [${s.name}](${s.baseUrl}) | **${s.securityGrade}** (${s.securityScore}) | **${s.qaGrade}** (${s.qaScore}) | ${s.counts.critical} | ${s.counts.high} | ${s.counts.medium} | ${s.counts.low} |\n`;
if (prev) md += `\n**מאז הריצה הקודמת:** ${findings.filter((f) => f.isNew).length} ממצאים חדשים · ${resolved.length} נפתרו ✅\n`;
md += blocking.length ? `\n## ⚠️ ${blocking.length} ממצאים חוסמים (חומרה ≥ ${SEV_HE[failOn]})\n\n` : `\n## ✅ אין ממצאים חוסמים\n\n`;
for (const f of blocking.slice(0, 40)) md += `- ${icon[f.severity]} **[${f.site}] ${f.title}**${f.isNew ? ' 🆕' : ''}${f.url ? ` — ${f.url}` : ''}${f.fix ? `\n  - 🔧 ${f.fix.split('\n')[0].slice(0, 200)}` : ''}\n`;
const mediums = findings.filter((f) => f.severity === 'medium');
if (mediums.length) {
  md += `\n<details><summary>🟨 ${mediums.length} ממצאים בינוניים</summary>\n\n`;
  for (const f of mediums.slice(0, 60)) md += `- [${f.site}] ${f.title}${f.isNew ? ' 🆕' : ''}${f.url ? ` — ${f.url}` : ''}\n`;
  md += `\n</details>\n`;
}
md += `\nהדוח המלא (HTML עם הסברים ותיקונים) מצורף כ-artifact בשם **qa-monster-report**.\n`;
fs.writeFileSync(path.join(REPORTS, 'summary.md'), md);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);

// 7. HTML (self-contained, RTL, works in email clients and browsers)
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:)'"])/g, '<a href="$1">$1</a>');
const gradeColor = (g) => ({ '—': '#757575', 'A+': '#0f9d58', A: '#34a853', B: '#7cb342', C: '#f9a825', D: '#ef6c00', F: '#d32f2f' })[g];
const sevColor = { critical: '#b71c1c', high: '#e65100', medium: '#f9a825', low: '#1565c0', info: '#757575' };

const siteHtml = perSite.map((s) => {
  const byCat = {};
  for (const f of s.findings) (byCat[f.category] ??= []).push(f);
  const cats = Object.entries(byCat).sort((a, b) => Math.max(...b[1].map((f) => RANK[f.severity])) - Math.max(...a[1].map((f) => RANK[f.severity])));
  return `
  <section class="site">
    <h2><a href="${esc(s.baseUrl)}">${esc(s.name)}</a></h2>
    <div class="cards">
      <div class="card"><div class="lbl">ציון אבטחה</div><div class="grade" style="color:${gradeColor(s.securityGrade)}">${s.securityGrade}</div><div class="num">${s.securityScore}/100</div></div>
      <div class="card"><div class="lbl">ציון QA</div><div class="grade" style="color:${gradeColor(s.qaGrade)}">${s.qaGrade}</div><div class="num">${s.qaScore}/100</div></div>
      ${['critical', 'high', 'medium', 'low'].map((k) => `<div class="card"><div class="lbl">${SEV_HE[k]}</div><div class="grade" style="color:${sevColor[k]}">${s.counts[k]}</div></div>`).join('')}
    </div>
    ${s.zapRan ? '' : '<p class="note">סריקת OWASP ZAP לא נכללה בריצה זו.</p>'}
    ${cats.map(([cat, list]) => `
      <details ${list.some((f) => RANK[f.severity] >= 3) ? 'open' : ''}>
        <summary><b>${esc(CAT_HE[cat] ?? cat)}</b> — ${list.filter((f) => f.severity !== 'info').length} ממצאים</summary>
        <table>
          ${list.map((f) => `<tr>
            <td class="sev"><span class="pill" style="background:${sevColor[f.severity]}">${SEV_HE[f.severity]}</span>${f.isNew ? '<span class="new">חדש</span>' : ''}</td>
            <td><div class="t" dir="auto">${esc(f.title)}</div>
              ${f.url ? `<div class="u">${linkify(f.url)}</div>` : ''}
              ${f.detail ? `<pre>${linkify(f.detail)}</pre>` : ''}
              ${f.fix ? `<div class="fix" dir="auto">🔧 ${linkify(f.fix)}</div>` : ''}</td></tr>`).join('')}
        </table>
      </details>`).join('')}
  </section>`;
}).join('');

const html = `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>QA Monster Report</title><style>
body{font-family:-apple-system,Segoe UI,Arial,sans-serif;background:#f4f6f9;color:#1d2433;margin:0;padding:16px}
.wrap{max-width:980px;margin:auto}
header{background:linear-gradient(135deg,#0d1b2a,#1b3a5c);color:#fff;border-radius:14px;padding:22px 24px;margin-bottom:18px}
header h1{margin:0 0 6px;font-size:24px} header p{margin:0;opacity:.8}
.site{background:#fff;border-radius:14px;padding:18px 20px;margin-bottom:18px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.site h2{margin:0 0 12px} .site h2 a{color:#1b3a5c;text-decoration:none}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:12px}
.card{flex:1 1 110px;background:#f7f9fc;border-radius:10px;padding:10px;text-align:center}
.lbl{font-size:12px;color:#5b6475}.grade{font-size:30px;font-weight:800}.num{font-size:12px;color:#5b6475}
details{border-top:1px solid #e6e9ef;padding:8px 0}summary{cursor:pointer;padding:4px 0}
table{width:100%;border-collapse:collapse;margin-top:6px}td{vertical-align:top;padding:8px 6px;border-top:1px solid #f0f2f5}
.sev{width:84px}.pill{color:#fff;border-radius:999px;padding:2px 8px;font-size:12px;white-space:nowrap}
.new{display:inline-block;margin-top:4px;background:#6a1b9a;color:#fff;border-radius:6px;padding:1px 6px;font-size:11px}
.t{font-weight:600}.u{font-size:12px;direction:ltr;text-align:left;word-break:break-all}
pre{white-space:pre-wrap;word-break:break-all;direction:ltr;text-align:left;background:#f7f9fc;border-radius:6px;padding:6px 8px;font-size:12px;margin:6px 0}
.fix{background:#e8f5e9;border-radius:6px;padding:6px 8px;font-size:13px;margin-top:4px}
.note{color:#8a6d00;background:#fff8e1;border-radius:6px;padding:6px 10px}
footer{text-align:center;color:#8a93a3;font-size:12px;margin-top:10px}
</style></head><body><div class="wrap">
<header><h1>🛡️ QA Monster — דוח אבטחה ואיכות</h1><p>${generatedAt.replace('T', ' ').slice(0, 16)} UTC · ${perSite.length} אתרים · ${findings.filter((f) => f.severity !== 'info').length} ממצאים${prev ? ` · ${findings.filter((f) => f.isNew).length} חדשים · ${resolved.length} נפתרו` : ''}${runUrl ? ` · <a style="color:#9cc9ff" href="${runUrl}">ריצה ב-GitHub</a>` : ''}</p></header>
${siteHtml}
${resolved.length ? `<section class="site"><h2>✅ נפתרו מאז הריצה הקודמת</h2><ul>${resolved.map((f) => `<li dir="auto">[${esc(f.site)}] ${esc(f.title)}</li>`).join('')}</ul></section>` : ''}
<footer>ציון: מתחיל ב-100, ניכוי לפי חומרה (קריטי 30, גבוה 12, בינוני 4, נמוך 1). A+ ≥ 95 · A ≥ 85 · B ≥ 75 · C ≥ 60 · D ≥ 45 · F</footer>
</div></body></html>`;
fs.writeFileSync(path.join(REPORTS, 'report.html'), html);

console.log(md);
if (process.argv.includes('--fail') && blocking.length) {
  console.error(`\n${blocking.length} blocking finding(s) at or above "${failOn}".`);
  process.exit(1);
}
