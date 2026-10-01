// Finalizes a run (appends run.end with the verdict and the comparison with the previous run) and
// renders report.html / summary.md / summary.json from the shared model.
import fs from 'node:fs';
import path from 'node:path';
import logger from '../../lib/logger.cjs';
import { buildRunModel, describeRun, pickBaseline, runEndPayload } from '../../lib/model.mjs';
import { renderEmailHtml, renderMarkdown } from '../../lib/render-email.mjs';
import { findRun, listRuns, readEventsFile } from './runs.mjs';

export function finalizeRun({ runId = 'latest', finalize = true, dir } = {}) {
  const runs = listRuns(dir);
  const run = findRun(runs, runId);
  if (!run) throw new Error(runId === 'latest' ? 'No runs found in runs/. Run `npm run audit` first.' : `Run "${runId}" not found in runs/`);

  const events = readEventsFile(run.file);
  const baseline = pickBaseline(runs, describeRun(events));
  const baselineEvents = baseline ? readEventsFile(baseline.file) : null;

  if (finalize) {
    // Record the verdict and comparison in the run itself, then render from what was recorded, exactly
    // as the dashboard will read it later.
    const fresh = buildRunModel(events, { baselineEvents, recomputeDiff: true });
    new logger.Logger({ runId: run.runId, file: run.file }).emit('run.end', runEndPayload(fresh));
  }
  const model = buildRunModel(readEventsFile(run.file), { baselineEvents });

  const env = process.env;
  const runUrl = model.github?.url ?? (env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined);
  const outDir = path.dirname(run.file);
  const markdown = renderMarkdown(model, { runUrl });
  fs.writeFileSync(path.join(outDir, 'report.html'), renderEmailHtml(model, { runUrl }));
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown);
  // Derived snapshot for shell steps (jq) in CI. Not a source of truth: regenerate from events.jsonl.
  fs.writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify({
    runId: model.runId,
    startedAt: model.startedAt,
    verdict: model.verdict,
    failOn: model.failOn,
    blocking: model.blocking.length,
    baselineRunId: model.diff?.baselineRunId ?? null,
    newCount: model.diff?.newCount ?? 0,
    resolvedCount: model.diff?.resolvedCount ?? 0,
    sites: model.sites.map((s) => ({
      name: s.name, baseUrl: s.baseUrl, securityScore: s.securityScore, securityGrade: s.securityGrade,
      qaScore: s.qaScore, qaGrade: s.qaGrade, counts: s.counts, newCount: s.newCount, resolvedCount: s.resolved.length,
      checksCompleted: s.checksCompleted, checksTotal: s.checksTotal,
    })),
  }, null, 2));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, markdown);
  return { model, run, outDir, markdown, baseline };
}
