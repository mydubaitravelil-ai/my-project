#!/usr/bin/env node
// npm run audit [-- <playwright args>] [--fail]
// Runs the Playwright checks for one new run, then finalizes it (comparison with the previous run) and
// builds the email report. Cross-platform: no shell operators, so it behaves the same on Windows.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import logger from '../lib/logger.cjs';
import { finalizeRun } from './lib/report.mjs';

const args = process.argv.slice(2);
const failOnBlocking = args.includes('--fail');
const runId = logger.ensureRunId(); // inherited by Playwright and its workers

const cli = createRequire(import.meta.url).resolve('@playwright/test/cli');
const res = spawnSync(process.execPath, [cli, 'test', ...args.filter((a) => a !== '--fail')], { stdio: 'inherit', env: process.env });
if (res.error) {
  console.error(res.error.message);
  process.exit(2);
}

try {
  const { model, outDir, baseline } = finalizeRun({ runId });
  console.log(`\nQA Monster run ${runId}`);
  for (const s of model.sites) {
    console.log(`  ${s.name.padEnd(22)} security ${s.securityGrade.padEnd(2)} · QA ${s.qaGrade.padEnd(2)} · ${s.open} open · ${s.hasBaseline ? `${s.newCount} new, ${s.resolved.length} resolved` : 'no baseline'}`);
  }
  console.log(`  ${model.blocking.length} blocking finding(s)${baseline ? ` · compared with ${baseline.runId}` : ''}`);
  console.log(`  Report: ${outDir}/report.html · Dashboard: npm run dashboard`);
  process.exit(failOnBlocking && model.blocking.length ? 1 : 0);
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
