#!/usr/bin/env node
// node scripts/ingest-zap.mjs --site <name> --mode baseline|full --target <url> --report report_json.json
//                             [--exit-code N] [--run <runId>] [--out <events.jsonl>]
import logger from '../lib/logger.cjs';
import { ingestZapReport } from './lib/zap-ingest.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const runId = opt('--run') ?? process.env.QA_RUN_ID;
for (const [name, value] of [['--site', opt('--site')], ['--mode', opt('--mode')], ['--target', opt('--target')], ['--run / QA_RUN_ID', runId]]) {
  if (!value) {
    console.error(`Missing ${name}`);
    process.exit(2);
  }
}
const out = new logger.Logger({ runId, file: opt('--out') });
const exitCode = opt('--exit-code');
const result = ingestZapReport({
  logger: out,
  site: opt('--site'),
  mode: opt('--mode'),
  target: opt('--target'),
  reportFile: opt('--report'),
  exitCode: exitCode === undefined || exitCode === '' ? undefined : Number(exitCode),
});
console.log(`ZAP ${opt('--mode')} for ${opt('--site')}: ${result.alerts} alert(s) → ${out.file}${result.completed ? '' : ' (scan did not complete)'}`);
