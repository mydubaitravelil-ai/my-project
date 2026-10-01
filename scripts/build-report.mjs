#!/usr/bin/env node
// Finalizes a run and builds its email report from events.jsonl.
//   node scripts/build-report.mjs [--run <runId>|latest] [--fail] [--no-finalize]
import { finalizeRun } from './lib/report.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

try {
  const { model, outDir, markdown, baseline } = finalizeRun({ runId: opt('--run') ?? 'latest', finalize: !args.includes('--no-finalize') });
  console.log(markdown);
  console.log(`\nReport: ${outDir}/report.html`);
  console.log(baseline ? `Compared with run ${baseline.runId}` : 'No earlier finalized run from the same source to compare with.');
  if (args.includes('--fail') && model.blocking.length) {
    console.error(`\n${model.blocking.length} blocking finding(s) at or above "${model.failOn}".`);
    process.exit(1);
  }
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
