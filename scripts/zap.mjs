#!/usr/bin/env node
// Runs OWASP ZAP locally in Docker and records the results as QA Monster events.
//
//   npm run zap -- --site mydubai-travel                      passive baseline of the live site
//   npm run zap -- --site mydubai-travel --full               ACTIVE scan of the site's stagingUrl (sites.json)
//   npm run zap -- --url http://localhost:3000 --site mydubai-travel --full
//                                                             ACTIVE scan of a local copy of the site
// Options: --run <runId|latest>  add the results to an existing run instead of starting a new one
//          --minutes <n>         spider time (default 5)
//
// Active scans send attack payloads: they are refused for production hosts (scripts/lib/zap-policy.mjs).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import logger from '../lib/logger.cjs';
import { finalizeRun } from './lib/report.mjs';
import { findRun, listRuns } from './lib/runs.mjs';
import { ingestZapReport } from './lib/zap-ingest.mjs';
import { assertZapAllowed, isLocalUrl, loadSitesConfig } from './lib/zap-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGE = process.env.ZAP_IMAGE ?? 'ghcr.io/zaproxy/zaproxy:stable';
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const die = (msg) => { console.error(msg); process.exit(1); };

const sites = loadSitesConfig();
const mode = args.includes('--full') ? 'full' : 'baseline';
const site = sites.find((s) => s.name === opt('--site'));
if (!site) die(`--site must be one of: ${sites.map((s) => s.name).join(', ')}`);
const target = opt('--url') ?? (mode === 'full' ? site.stagingUrl : site.baseUrl);
if (!target) die(`${site.name} has no stagingUrl in sites.json. Active scans never run against production; pass --url <local address> or set stagingUrl.`);

try {
  assertZapAllowed({ mode, url: target, sites, allowLocal: true });
} catch (e) {
  die(e.message);
}
if (spawnSync('docker', ['version'], { stdio: 'ignore' }).status !== 0) die('Docker is required for ZAP scans: https://docs.docker.com/get-docker/');

// Results go into an existing run (--run) or a new local run.
let runId;
let existing = null;
if (opt('--run')) {
  existing = findRun(listRuns(), opt('--run'));
  if (!existing) die(`Run "${opt('--run')}" not found`);
  runId = existing.runId;
} else {
  runId = logger.newRunId('local');
}
const log = new logger.Logger({ runId });
if (!existing) {
  log.emit('run.start', {
    source: 'local',
    sites: [{ name: site.name, baseUrl: site.baseUrl }],
    failOn: process.env.FAIL_ON || 'high',
    expect: ['security'],
    tool: { name: 'qa-monster', zap: IMAGE },
  });
}

const wrk = path.join(log.runDir(), 'zap', site.name);
fs.mkdirSync(wrk, { recursive: true });
fs.chmodSync(wrk, 0o777); // the container runs as the unprivileged "zap" user
fs.copyFileSync(path.join(ROOT, '.zap', 'rules.tsv'), path.join(wrk, 'rules.tsv'));

// From inside the container, "localhost" is the container itself.
const dockerTarget = isLocalUrl(target) ? target.replace(/\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/, '//host.docker.internal') : target;
const script = mode === 'full' ? 'zap-full-scan.py' : 'zap-baseline.py';
const dockerArgs = [
  'run', '--rm', '-v', `${wrk}:/zap/wrk/:rw`, '--add-host=host.docker.internal:host-gateway', IMAGE,
  script, '-t', dockerTarget, '-J', 'report_json.json', '-r', 'report_html.html', '-c', 'rules.tsv', '-a', '-m', opt('--minutes') ?? '5',
];
console.log(`ZAP ${mode} scan of ${target} (run ${runId})…`);
const started = Date.now();
const res = spawnSync('docker', dockerArgs, { stdio: 'inherit' });

const result = ingestZapReport({
  logger: log,
  site: site.name,
  mode,
  target,
  reportFile: path.join(wrk, 'report_json.json'),
  exitCode: res.status ?? 3,
  durationMs: Date.now() - started,
});
const html = path.join(wrk, 'report_html.html');
if (fs.existsSync(html)) {
  log.child({ site: site.name, category: 'zap', check: `ZAP ${mode} scan` })
    .emit('artifact', { kind: 'zap-report', path: path.relative(log.runDir(), html).split(path.sep).join('/'), label: `ZAP ${mode} report` });
}
log.emit('run.phase', { phase: 'zap' });

const { outDir } = finalizeRun({ runId });
console.log(`\n${result.alerts} alert(s). Report: ${outDir}/report.html · dashboard: npm run dashboard`);
