// Turns an OWASP ZAP JSON report into QA Monster events (check.start, findings, metric, check.end).
import fs from 'node:fs';

const ZAP_RISK = { 3: 'high', 2: 'medium', 1: 'low', 0: 'info' };
const RANK = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };
const text = (html) => String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const bare = (h) => String(h ?? '').toLowerCase().replace(/^www\./, '');

export const zapCheckName = (mode) => `ZAP ${mode} scan`;

export function ingestZapReport({ logger, site, mode, target, reportFile, exitCode, durationMs }) {
  const log = logger.child({ site, category: 'zap', check: zapCheckName(mode) });
  log.emit('check.start', { mode, target });
  const fail = (error) => {
    log.emit('check.end', { status: 'failed', completed: false, durationMs, error });
    return { alerts: 0, completed: false };
  };
  if (!reportFile || !fs.existsSync(reportFile)) return fail(`ZAP report not found${exitCode !== undefined ? ` (zap exit code ${exitCode})` : ''}`);

  let report;
  try {
    report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  } catch (e) {
    return fail(`ZAP report is not valid JSON: ${e.message}`);
  }

  const targetHost = bare(new URL(target).hostname);
  const minRank = RANK[process.env.FAIL_ON ?? 'high'] ?? 3;
  let alerts = 0;
  let thirdParty = 0;
  let blocking = 0;
  for (const s of report.site ?? []) {
    let host = s['@host'];
    if (!host) {
      try { host = new URL(s['@name']).hostname; } catch { host = ''; }
    }
    if (bare(host) !== targetHost) {
      thirdParty += (s.alerts ?? []).length; // alerts about CDNs / analytics hosts are not this site's
      continue;
    }
    for (const a of s.alerts ?? []) {
      const severity = ZAP_RISK[a.riskcode] ?? 'info';
      const instances = a.instances ?? [];
      const reference = text(a.reference).match(/https?:\/\/\S+/)?.[0];
      log.finding({
        severity,
        title: `${a.name ?? a.alert} (${a.count ?? instances.length}×)`,
        url: instances[0]?.uri,
        detail: [
          text(a.desc).slice(0, 600),
          ...instances.slice(0, 5).map((i) => [i.method, i.uri, i.param && `param=${i.param}`, i.evidence && `evidence: ${i.evidence}`].filter(Boolean).join(' ')),
        ].filter(Boolean).join('\n'),
        fix: [text(a.solution), reference].filter(Boolean).join('\n'),
        key: `zap|${a.alertRef || a.pluginid}`,
        source: 'zap',
      });
      alerts++;
      if (RANK[severity] >= minRank) blocking++;
    }
  }
  log.metric('zapAlerts', alerts, { url: target });
  if (thirdParty) log.info(`Ignored ${thirdParty} ZAP alert(s) about third-party hosts`);

  const completed = exitCode === undefined || exitCode === null || Number(exitCode) < 3;
  log.emit('check.end', {
    status: !completed ? 'failed' : blocking ? 'failed' : 'passed',
    completed,
    blocking,
    durationMs,
    error: completed ? undefined : `zap exited with code ${exitCode}`,
  });
  return { alerts, completed };
}
