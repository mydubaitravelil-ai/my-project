#!/usr/bin/env node
// Local dashboard server: npm run dashboard  →  http://127.0.0.1:4173
// Serves the dashboard UI, the shared model (lib/model.mjs), the runs in runs/, and a GitHub sync endpoint.
// Listens on 127.0.0.1 only and rejects foreign Host headers (DNS rebinding) and cross-site POSTs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncGithubRuns } from './lib/github.mjs';
import { listRuns, runsDir } from './lib/runs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const PORT = Number(opt('--port') ?? process.env.PORT ?? 4173);
const HOST = opt('--host') ?? process.env.HOST ?? '127.0.0.1';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.tsv': 'text/plain; charset=utf-8',
};
// Shared modules the browser imports; nothing else from lib/ is exposed.
const SHARED = { '/lib/model.mjs': 'lib/model.mjs', '/lib/render-email.mjs': 'lib/render-email.mjs' };

function safeJoin(base, rel) {
  const target = path.resolve(base, `.${path.sep}${decodeURIComponent(rel)}`);
  return target.startsWith(path.resolve(base) + path.sep) ? target : null;
}

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function sendFile(res, file) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not found' });
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(file).pipe(res);
}

function runList() {
  return listRuns().map((r) => ({
    runId: r.runId,
    dir: r.dir,
    source: r.source,
    startedAt: r.startedAt,
    lastEventAt: r.lastEventAt,
    status: r.status,
    finalized: r.finalized,
    verdict: r.verdict,
    blocking: r.blocking,
    sites: r.sites,
    github: r.github,
    git: r.git,
    bytes: r.bytes,
    hasReport: fs.existsSync(path.join(path.dirname(r.file), 'report.html')),
  }));
}

const server = http.createServer(async (req, res) => {
  const host = (req.headers.host ?? '').replace(/:\d+$/, '');
  if (!['127.0.0.1', 'localhost', '[::1]', HOST].includes(host)) return send(res, 403, { error: 'forbidden host' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === 'GET') {
      if (p === '/' || p === '/index.html') return sendFile(res, path.join(ROOT, 'dashboard', 'index.html'));
      if (p.startsWith('/dashboard/')) return sendFile(res, safeJoin(path.join(ROOT, 'dashboard'), p.slice('/dashboard/'.length)));
      if (SHARED[p]) return sendFile(res, path.join(ROOT, SHARED[p]));
      if (p === '/api/runs') return send(res, 200, { runsDir: runsDir(), runs: runList() });
      if (p.startsWith('/runs/')) return sendFile(res, safeJoin(runsDir(), p.slice('/runs/'.length)));
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && p === '/api/github/sync') {
      // A custom header can't be sent cross-site without a CORS preflight, which this server never grants.
      if (req.headers['x-qa-monster'] !== '1') return send(res, 403, { error: 'missing X-QA-Monster header' });
      const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit') ?? 10)));
      try {
        return send(res, 200, await syncGithubRuns({ limit }));
      } catch (e) {
        return send(res, 400, { error: e.message });
      }
    }
    return send(res, 405, { error: 'method not allowed' });
  } catch (e) {
    return send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`QA Monster dashboard: http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`Runs directory: ${runsDir()} (${listRuns().length} run(s))`);
});
