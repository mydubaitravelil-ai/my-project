import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import logger from '../../lib/logger.cjs';
import { buildRunModel, parseEvents } from '../../lib/model.mjs';
import { ingestZapReport } from '../../scripts/lib/zap-ingest.mjs';
import { assertZapAllowed, isLocalUrl, zapTargets } from '../../scripts/lib/zap-policy.mjs';

const sites = [
  { name: 'dubai', baseUrl: 'https://mydubai-travel.com', stagingUrl: 'https://staging.mydubai-travel.com' },
  { name: 'thai', baseUrl: 'https://thailand-express.com', stagingUrl: null },
];

describe('ZAP policy: live sites passive only', () => {
  test('active scans of production are refused, including www and paths', () => {
    for (const url of ['https://mydubai-travel.com', 'https://www.mydubai-travel.com/', 'http://mydubai-travel.com/staging', 'https://thailand-express.com']) {
      assert.throws(() => assertZapAllowed({ mode: 'full', url, sites }), /production/, url);
    }
  });

  test('active scans run against a staging URL or (locally) a local address', () => {
    assert.doesNotThrow(() => assertZapAllowed({ mode: 'full', url: 'https://staging.mydubai-travel.com/x', sites, allowLocal: false }));
    assert.doesNotThrow(() => assertZapAllowed({ mode: 'full', url: 'http://localhost:3000', sites }));
    assert.throws(() => assertZapAllowed({ mode: 'full', url: 'http://localhost:3000', sites, allowLocal: false }));
    assert.throws(() => assertZapAllowed({ mode: 'full', url: 'https://someone-else.com', sites }), /neither/);
  });

  test('passive baseline: listed sites only', () => {
    assert.doesNotThrow(() => assertZapAllowed({ mode: 'baseline', url: 'https://thailand-express.com', sites }));
    assert.throws(() => assertZapAllowed({ mode: 'baseline', url: 'https://someone-else.com', sites }));
    assert.throws(() => assertZapAllowed({ mode: 'turbo', url: 'https://thailand-express.com', sites }));
  });

  test('CI matrix: baseline = live URLs; full = staging URLs only', () => {
    assert.deepEqual(zapTargets({ mode: 'baseline', sites }).map((t) => t.url), ['https://mydubai-travel.com', 'https://thailand-express.com']);
    assert.deepEqual(zapTargets({ mode: 'full', sites }), [{ name: 'dubai', url: 'https://staging.mydubai-travel.com', mode: 'full' }]);
    assert.deepEqual(zapTargets({ mode: 'baseline', sites, only: 'thai' }).map((t) => t.name), ['thai']);
    const misconfigured = [{ name: 'x', baseUrl: 'https://x.com', stagingUrl: 'https://www.x.com' }];
    assert.throws(() => zapTargets({ mode: 'full', sites: misconfigured }), /production/);
  });

  test('isLocalUrl', () => {
    for (const u of ['http://localhost:3000', 'http://127.0.0.1', 'http://192.168.1.20', 'http://10.0.0.5:8080', 'http://site.test', 'http://[::1]:3000']) assert.ok(isLocalUrl(u), u);
    for (const u of ['https://mydubai-travel.com', 'http://172.32.0.1', 'http://8.8.8.8']) assert.ok(!isLocalUrl(u), u);
  });
});

describe('ZAP ingest', () => {
  const report = {
    site: [
      {
        '@name': 'https://mydubai-travel.com', '@host': 'mydubai-travel.com',
        alerts: [
          { pluginid: '10038', alertRef: '10038-1', name: 'CSP Header Not Set', riskcode: '2', count: '3', desc: '<p>desc</p>', solution: '<p>Set CSP</p>', reference: '<p>https://example.org/csp</p>', instances: [{ uri: 'https://mydubai-travel.com/', method: 'GET' }] },
          { pluginid: '40012', name: 'Cross Site Scripting (Reflected)', riskcode: '3', count: '1', instances: [{ uri: 'https://mydubai-travel.com/?q=x', method: 'GET', param: 'q', evidence: '<script>' }] },
        ],
      },
      { '@name': 'https://www.google-analytics.com', '@host': 'www.google-analytics.com', alerts: [{ pluginid: '1', name: 'third party', riskcode: '3' }] },
    ],
  };

  test('maps risk to severity, ignores third-party hosts, records a completed check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-zap-'));
    const reportFile = path.join(dir, 'report_json.json');
    fs.writeFileSync(reportFile, JSON.stringify(report));
    const log = new logger.Logger({ runId: 'r', file: path.join(dir, 'events.jsonl') });
    const result = ingestZapReport({ logger: log, site: 'dubai', mode: 'baseline', target: 'https://www.mydubai-travel.com', reportFile, exitCode: 2 });
    assert.deepEqual(result, { alerts: 2, completed: true });
    const { events } = parseEvents(fs.readFileSync(log.file, 'utf8'));
    const model = buildRunModel(events);
    const zap = model.findings.filter((x) => x.category === 'zap');
    assert.deepEqual(zap.map((x) => x.severity).sort(), ['high', 'medium']);
    assert.ok(zap.find((x) => x.severity === 'medium').fix.includes('https://example.org/csp'));
    assert.equal(model.checks[0].check, 'ZAP baseline scan');
    assert.equal(model.checks[0].completed, true);
  });

  test('a missing report or a crashed scan is an incomplete check', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-zap-'));
    const log = new logger.Logger({ runId: 'r', file: path.join(dir, 'events.jsonl') });
    assert.equal(ingestZapReport({ logger: log, site: 'dubai', mode: 'baseline', target: 'https://mydubai-travel.com', reportFile: path.join(dir, 'nope.json') }).completed, false);
    const { events } = parseEvents(fs.readFileSync(log.file, 'utf8'));
    assert.equal(events.at(-1).type, 'check.end');
    assert.equal(events.at(-1).completed, false);
  });
});
