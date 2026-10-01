import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterEach, describe, test } from 'node:test';
import { syncGithubRuns, unzip } from '../../scripts/lib/github.mjs';

/** Minimal ZIP writer (stored or deflate) for tests. */
function makeZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content, method = 8] of files) {
    const data = Buffer.from(content);
    const body = method === 8 ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(method, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(method, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, n, body);
    centrals.push(central, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(files.length, 8); eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

const eventsOf = (runId) => [
  { v: 1, ts: '2026-10-01T03:00:00.000Z', runId, type: 'run.start', source: 'github', sites: [{ name: 'a', baseUrl: 'https://a' }] },
  { v: 1, ts: '2026-10-01T03:10:00.000Z', runId, type: 'run.end', status: 'pass' },
].map((e) => JSON.stringify(e)).join('\n');

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('GitHub runs', () => {
  test('unzip reads stored and deflated entries', () => {
    const entries = unzip(makeZip([['a.txt', 'hello', 0], ['dir/b.txt', 'world '.repeat(100), 8]]));
    assert.deepEqual(entries.map((e) => [e.name, e.data.toString().slice(0, 6)]), [['a.txt', 'hello'], ['dir/b.txt', 'world ']]);
    assert.throws(() => unzip(Buffer.from('not a zip at all, definitely not')), /zip/);
  });

  test('syncGithubRuns downloads new runs once, skips excluded/expired ones, blocks zip-slip, drops the token on redirect', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-sync-'));
    const calls = [];
    globalThis.fetch = async (url, opts = {}) => {
      calls.push({ url: String(url), auth: opts.headers?.Authorization });
      if (String(url).includes('/actions/artifacts?')) {
        return Response.json({ artifacts: [
          { id: 11, expired: false, created_at: '2026-10-01T05:00:00Z', workflow_run: { id: 500, head_branch: 'main' } },
          { id: 12, expired: false, created_at: '2026-10-01T06:00:00Z', workflow_run: { id: 501, head_branch: 'main' } },
          { id: 13, expired: true, created_at: '2026-10-01T04:00:00Z', workflow_run: { id: 499, head_branch: 'main' } },
        ] });
      }
      if (String(url).endsWith('/artifacts/11/zip')) return new Response(null, { status: 302, headers: { location: 'https://blob.example/11' } });
      if (String(url) === 'https://blob.example/11') {
        return new Response(makeZip([['events.jsonl', eventsOf('gh-500-1')], ['artifacts/a/shot.png', 'png'], ['../../evil.txt', 'x']]));
      }
      return new Response('not found', { status: 404 });
    };

    const first = await syncGithubRuns({ dir, repo: 'o/r', token: 't', excludeRunId: 501, limit: 5 });
    assert.deepEqual(first.added, ['gh-500-1']);
    assert.ok(fs.existsSync(path.join(dir, 'gh-500-1', 'events.jsonl')));
    assert.ok(fs.existsSync(path.join(dir, 'gh-500-1', 'artifacts', 'a', 'shot.png')));
    assert.ok(!fs.existsSync(path.join(dir, '..', 'evil.txt')) && !fs.existsSync(path.join(dir, 'evil.txt')));
    assert.equal(calls.find((c) => c.url === 'https://blob.example/11').auth, undefined, 'token must not reach the storage host');
    assert.ok(!calls.some((c) => c.url.includes('/artifacts/12/') || c.url.includes('/artifacts/13/')));

    const second = await syncGithubRuns({ dir, repo: 'o/r', token: 't', excludeRunId: 501, limit: 5 });
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.skipped, ['gh-500-1']);
  });

  test('a clear error without a token', async () => {
    await assert.rejects(syncGithubRuns({ dir: os.tmpdir(), repo: 'o/r', token: null }), /token/);
  });
});
