// Downloads QA Monster runs from GitHub Actions (the "qa-monster-events" artifact of each workflow run)
// into runs/<runId>/, so the dashboard and the report builder see them like local runs.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describeRun, parseEvents } from '../../lib/model.mjs';
import { runsDir as defaultRunsDir } from './runs.mjs';

export const ARTIFACT_NAME = 'qa-monster-events';

/** Minimal ZIP reader (stored + deflate entries), enough for GitHub artifact archives. */
export function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}`);
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) entries.push({ name, data: Buffer.from(raw) });
    else if (method === 8) entries.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`Unsupported zip compression method ${method} (${name})`);
  }
  return entries;
}

function detectRepo() {
  if (process.env.QA_GITHUB_REPO) return process.env.QA_GITHUB_REPO;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['config', '--get', 'remote.origin.url'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/) ?? url.match(/\/([^/]+)\/([^/]+?)(?:\.git)?$/);
    return m ? `${m[1]}/${m[2]}` : null;
  } catch {
    return null;
  }
}

function detectToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync('gh', ['auth', 'token'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * Downloads up to `limit` recent runs that are not on disk yet.
 * `excludeRunId` skips a workflow run (CI uses it to skip itself); `branch` keeps one branch only.
 */
export async function syncGithubRuns({ limit = 10, excludeRunId, branch, dir = defaultRunsDir(), repo = detectRepo(), token = detectToken() } = {}) {
  if (!repo) throw new Error('Could not detect the GitHub repository. Set QA_GITHUB_REPO=owner/repo.');
  if (!token) throw new Error('No GitHub token. Run `gh auth login`, or set GITHUB_TOKEN to a token with "Actions: read" access.');

  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'qa-monster' };
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts?name=${ARTIFACT_NAME}&per_page=100`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${res.status} listing artifacts of ${repo}: ${(await res.text()).slice(0, 300)}`);
  const { artifacts = [] } = await res.json();

  const indexFile = path.join(dir, '.github-artifacts.json');
  const index = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : {};
  const candidates = artifacts
    .filter((a) => !a.expired && String(a.workflow_run?.id) !== String(excludeRunId ?? ''))
    .filter((a) => !branch || a.workflow_run?.head_branch === branch)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    .slice(0, limit);

  const result = { repo, added: [], skipped: [], failed: [] };
  for (const a of candidates) {
    if (index[a.id] && fs.existsSync(path.join(dir, index[a.id], 'events.jsonl'))) {
      result.skipped.push(index[a.id]);
      continue;
    }
    try {
      // The API answers with a redirect to a pre-signed storage URL, which must be fetched without our token.
      const redirect = await fetch(`https://api.github.com/repos/${repo}/actions/artifacts/${a.id}/zip`, { headers, redirect: 'manual' });
      const location = redirect.headers.get('location');
      const zip = location ? await fetch(location) : redirect;
      if (!zip.ok) throw new Error(`download failed (${zip.status})`);
      const entries = unzip(Buffer.from(await zip.arrayBuffer()));
      const eventsEntry = entries.filter((e) => e.name.split('/').pop() === 'events.jsonl').sort((x, y) => x.name.length - y.name.length)[0];
      if (!eventsEntry) throw new Error('artifact has no events.jsonl');
      const info = describeRun(parseEvents(eventsEntry.data.toString('utf8')).events);
      if (!info.runId || /[\\/]|\.\./.test(info.runId)) throw new Error('events.jsonl has no valid runId');

      const prefix = eventsEntry.name.slice(0, -'events.jsonl'.length);
      const target = path.join(dir, info.runId);
      for (const e of entries) {
        if (!e.name.startsWith(prefix)) continue;
        const out = path.resolve(target, e.name.slice(prefix.length));
        if (!out.startsWith(path.resolve(target) + path.sep)) continue; // zip-slip guard
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, e.data);
      }
      index[a.id] = info.runId;
      result.added.push(info.runId);
    } catch (e) {
      result.failed.push({ artifact: a.id, workflowRun: a.workflow_run?.id, error: e.message });
    }
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));
  return result;
}
