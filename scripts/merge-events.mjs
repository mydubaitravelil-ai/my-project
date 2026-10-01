#!/usr/bin/env node
// Merges event shards from parallel CI jobs (Playwright, one ZAP job per site) into one events.jsonl.
//   node scripts/merge-events.mjs <target events.jsonl> <shard.jsonl...>
import fs from 'node:fs';
import path from 'node:path';
import { parseEvents, sortEvents } from '../lib/model.mjs';
import { loadSitesConfig } from './lib/zap-policy.mjs';

const [target, ...shards] = process.argv.slice(2);
if (!target) {
  console.error('usage: merge-events.mjs <target> <shard...>');
  process.exit(2);
}

const seen = new Set();
const events = [];
let invalid = 0;
for (const file of [target, ...shards]) {
  if (!fs.existsSync(file)) continue;
  const parsed = parseEvents(fs.readFileSync(file, 'utf8'));
  invalid += parsed.invalid;
  for (const e of parsed.events) {
    const key = JSON.stringify(e);
    if (seen.has(key)) continue; // merging the same shard twice is harmless
    seen.add(key);
    events.push(e);
  }
}
if (!events.length) {
  console.error('No events to merge.');
  process.exit(1);
}

const runIds = [...new Set(events.map((e) => e.runId))];
if (runIds.length > 1) console.warn(`Warning: shards belong to several runs: ${runIds.join(', ')}`);

// If the Playwright job produced nothing, still describe the run, so the report says which checks are missing.
if (!events.some((e) => e.type === 'run.start')) {
  const only = process.env.SITE ? process.env.SITE.split(',').map((s) => s.trim()) : null;
  const first = sortEvents(events)[0];
  events.push({
    v: 1, ts: first.ts, runId: first.runId, pid: 0, seq: 0, type: 'run.start',
    source: process.env.QA_RUN_SOURCE ?? 'github',
    sites: loadSitesConfig().filter((s) => !only || only.includes(s.name)).map((s) => ({ name: s.name, baseUrl: s.baseUrl })),
    failOn: process.env.FAIL_ON ?? 'high',
    expect: ['qa', 'security'],
    reconstructed: true,
  });
  console.warn('Warning: no run.start found (did the Playwright job run?); added one from sites.json.');
}

fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
fs.writeFileSync(target, sortEvents(events).map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(`Merged ${events.length} events from ${1 + shards.length} file(s) into ${target}${invalid ? ` (${invalid} malformed line(s) skipped)` : ''}`);
