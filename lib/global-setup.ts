import { execSync } from 'node:child_process';
import type { FullConfig } from '@playwright/test';
import { ensureRunId, Logger, runSource } from './logger.cjs';
import type { Site } from './site';

function gitInfo() {
  if (process.env.GITHUB_SHA) return { sha: process.env.GITHUB_SHA, ref: process.env.GITHUB_REF_NAME };
  const git = (args: string) => execSync(`git ${args}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  try {
    return { sha: git('rev-parse HEAD'), ref: git('rev-parse --abbrev-ref HEAD') };
  } catch {
    return undefined;
  }
}

/** Values of --project on the command line (supports `*` wildcards, case-insensitive), or null. */
function projectFilter(argv: string[]): RegExp[] | null {
  const names: string[] = [];
  argv.forEach((a, i) => {
    if (a === '--project' && argv[i + 1]) names.push(argv[i + 1]);
    else if (a.startsWith('--project=')) names.push(a.slice('--project='.length));
  });
  if (!names.length) return null;
  return names.map((n) => new RegExp(`^${n.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i'));
}

/** Records run.start before any check runs. Lives here (not in a reporter) so `--reporter` can't disable it. */
export default async function globalSetup(config: FullConfig) {
  const filter = projectFilter(process.argv);
  const sites = config.projects
    .filter((p) => !filter || filter.some((re) => re.test(p.name)))
    .map((p) => p.metadata?.site as Site | undefined)
    .filter((s): s is Site => !!s)
    .map((s) => ({ name: s.name, baseUrl: s.baseUrl }));
  const env = process.env;
  new Logger({ runId: ensureRunId() }).emit('run.start', {
    source: runSource(),
    sites,
    failOn: env.FAIL_ON || 'high',
    // Check groups this run must cover per site (set in CI); a missing group becomes a high finding.
    expect: env.QA_EXPECT ? env.QA_EXPECT.split(',').map((s) => s.trim()) : undefined,
    git: gitInfo(),
    github: env.GITHUB_RUN_ID
      ? {
          runId: env.GITHUB_RUN_ID,
          attempt: env.GITHUB_RUN_ATTEMPT,
          url: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
          event: env.GITHUB_EVENT_NAME,
        }
      : undefined,
    tool: { name: 'qa-monster', playwright: config.version },
  });
}
