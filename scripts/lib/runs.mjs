// Finds runs on disk (runs/<runId>/events.jsonl) for the report builder and the dashboard server.
import fs from 'node:fs';
import path from 'node:path';
import logger from '../../lib/logger.cjs';
import { describeRun, parseEvents } from '../../lib/model.mjs';

export const runsDir = () => logger.runsDir();

export function readEventsFile(file) {
  return parseEvents(fs.readFileSync(file, 'utf8')).events;
}

// describeRun() per events file, reused while the file is unchanged (the dashboard polls this list).
const described = new Map();

/** All runs, newest first. */
export function listRuns(dir = runsDir()) {
  if (!fs.existsSync(dir)) return [];
  const runs = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const file = path.join(dir, d.name, 'events.jsonl');
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    const key = `${stat.size}:${stat.mtimeMs}`;
    let info = described.get(file);
    if (info?.key !== key) {
      const events = readEventsFile(file);
      info = { key, run: events.length ? describeRun(events) : null };
      described.set(file, info);
    }
    if (!info.run) continue;
    // "stale" depends on the clock, so recompute it for running runs.
    const run = info.run.status === 'running' ? describeRun(readEventsFile(file)) : info.run;
    runs.push({ ...run, dir: d.name, file, bytes: stat.size, mtime: stat.mtime.toISOString() });
  }
  return runs.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function findRun(runs, id) {
  if (!id || id === 'latest') return runs[0] ?? null;
  return runs.find((r) => r.runId === id || r.dir === id) ?? null;
}
