'use strict';
// QA Monster event logger. Every check reports through here: findings, metrics, artifacts,
// lifecycle events. Events are appended as JSON lines to runs/<runId>/events.jsonl, the single
// source of truth that both the email report and the dashboard are built from (lib/model.mjs).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const ROOT = path.resolve(__dirname, '..');
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'];
const LIMITS = { title: 300, detail: 4000, fix: 1500, message: 2000, url: 2000 };

function runsDir() {
  return path.resolve(process.env.QA_RUNS_DIR || path.join(ROOT, 'runs'));
}

function runSource() {
  return process.env.QA_RUN_SOURCE || (process.env.GITHUB_ACTIONS === 'true' ? 'github' : 'local');
}

function newRunId(source = runSource()) {
  if (source === 'github' && process.env.GITHUB_RUN_ID) {
    return `gh-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT || 1}`;
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${source}-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/**
 * Fixes QA_RUN_ID / QA_RUN_SOURCE for this process tree. Called from playwright.config.ts, which the
 * main process evaluates first; workers inherit the environment, so every process shares one run id.
 */
function ensureRunId() {
  if (!process.env.QA_RUN_SOURCE) process.env.QA_RUN_SOURCE = runSource();
  if (!process.env.QA_RUN_ID) process.env.QA_RUN_ID = newRunId(process.env.QA_RUN_SOURCE);
  return process.env.QA_RUN_ID;
}

function eventsFile(runId) {
  return path.join(runsDir(), runId, 'events.jsonl');
}

/** Lowercases and replaces numbers with '#', so "Slow load: 5234 ms" and "Slow load: 6100 ms" match. */
function normalizeKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\d+(?:[.,]\d+)*/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

function fingerprint(...parts) {
  return crypto
    .createHash('sha1')
    .update(parts.map((p) => String(p ?? '')).join('\u0000'))
    .digest('hex')
    .slice(0, 16);
}

/** Category of a spec file: tests/qa/seo.spec.ts → "seo"; anything under tests/flows/ → "flows". */
function categoryOf(file) {
  const rel = String(file).split(path.sep).join('/');
  if (rel.includes('/flows/')) return 'flows';
  return path.posix.basename(rel).replace(/\.(spec|test)\.[cm]?[jt]s$/, '');
}

const clip = (v, n) => {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v);
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

const readyDirs = new Set();
let seq = 0;

class Logger {
  constructor({ runId = process.env.QA_RUN_ID, file, context = {} } = {}) {
    if (!runId) throw new Error('QA_RUN_ID is not set (ensureRunId() runs in playwright.config.ts)');
    this.runId = runId;
    this.file = path.resolve(file || eventsFile(runId));
    this.context = context;
  }

  child(context) {
    return new Logger({ runId: this.runId, file: this.file, context: { ...this.context, ...context } });
  }

  /** Directory artifacts of this run are stored under (next to events.jsonl). */
  runDir() {
    return path.dirname(this.file);
  }

  emit(type, data = {}) {
    const event = { v: SCHEMA_VERSION, ts: new Date().toISOString(), runId: this.runId, pid: process.pid, seq: ++seq, type, ...this.context, ...data };
    for (const k of Object.keys(event)) if (event[k] === undefined) delete event[k];
    const dir = path.dirname(this.file);
    if (!readyDirs.has(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      readyDirs.add(dir);
    }
    // One write per line with O_APPEND: lines from parallel workers never interleave.
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`);
    return event;
  }

  /**
   * Stable identity of a finding across runs. Numbers are normalised away; pass `key` when the title or
   * the first line of `detail` is volatile (lists, referrers, sizes) and something else identifies it.
   */
  findingFingerprint({ title, url, detail, key }) {
    const { site, category, check } = this.context;
    const k = key !== undefined && key !== null
      ? `key:${key}`
      : `${normalizeKey(title)}|${url ?? ''}|${normalizeKey(String(detail ?? '').split('\n')[0])}`;
    return fingerprint(site, category, check, k);
  }

  finding({ severity, title, url, detail, fix, key, source = 'playwright', fp }) {
    if (!SEVERITIES.includes(severity)) throw new Error(`Unknown severity "${severity}"`);
    return this.emit('finding', {
      fp: fp || this.findingFingerprint({ title, url, detail, key }),
      severity,
      title: clip(title, LIMITS.title),
      url: clip(url, LIMITS.url),
      detail: clip(detail, LIMITS.detail),
      fix: clip(fix, LIMITS.fix),
      source,
    });
  }

  metric(name, value, { unit, url, budget } = {}) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return this.emit('metric', { name, value: Math.round(value * 1000) / 1000, unit, url: clip(url, LIMITS.url), budget });
  }

  /** Writes a file into runs/<runId>/artifacts/ and records it, so the dashboard can show it. */
  saveArtifact(kind, relPath, body, { label, url } = {}) {
    const safe = relPath.split(/[\\/]+/).map((p) => p.replace(/[^\w.\-]+/g, '_')).filter((p) => p && p !== '..').join('/');
    const target = path.join(this.runDir(), 'artifacts', ...safe.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
    return this.emit('artifact', { kind, path: `artifacts/${safe}`, label, url: clip(url, LIMITS.url), bytes: body.length });
  }

  log(level, message, data = {}) {
    return this.emit('log', { level, message: clip(message, LIMITS.message), ...data });
  }

  info(message, data) { return this.log('info', message, data); }
  warn(message, data) { return this.log('warn', message, data); }
  error(message, data) { return this.log('error', message, data); }
}

let rootLogger;
/** Per-process logger for the current run (QA_RUN_ID). */
function getLogger() {
  if (!rootLogger || rootLogger.runId !== process.env.QA_RUN_ID) rootLogger = new Logger({ runId: ensureRunId() });
  return rootLogger;
}

module.exports = {
  SCHEMA_VERSION,
  SEVERITIES,
  Logger,
  categoryOf,
  ensureRunId,
  eventsFile,
  fingerprint,
  getLogger,
  newRunId,
  normalizeKey,
  runSource,
  runsDir,
};
