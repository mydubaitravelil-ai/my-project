#!/usr/bin/env node
// Downloads recent QA Monster runs from GitHub Actions into runs/ (for the dashboard and for comparisons).
//   node scripts/sync-github.mjs [--limit 10] [--exclude-run <workflow run id>] [--branch main]
// Needs a token with "Actions: read": `gh auth login`, or GITHUB_TOKEN / GH_TOKEN.
import { syncGithubRuns } from './lib/github.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

try {
  const r = await syncGithubRuns({ limit: Number(opt('--limit') ?? 10), excludeRunId: opt('--exclude-run'), branch: opt('--branch') });
  console.log(`${r.repo}: ${r.added.length} run(s) downloaded, ${r.skipped.length} already present.`);
  for (const id of r.added) console.log(`  + ${id}`);
  for (const f of r.failed) console.warn(`  ! artifact ${f.artifact} (workflow run ${f.workflowRun}): ${f.error}`);
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
