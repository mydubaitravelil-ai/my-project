import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import logger from '../../lib/logger.cjs';
import { parseEvents } from '../../lib/model.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qa-logger-'));
const LOGGER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../lib/logger.cjs');

describe('logger', () => {
  test('fingerprints ignore numbers, honour explicit keys, and include the check identity', () => {
    const file = path.join(tmp(), 'events.jsonl');
    const a = new logger.Logger({ runId: 'r', file, context: { site: 's', category: 'availability', check: 'c' } });
    assert.equal(a.findingFingerprint({ title: 'Slow load: 5234 ms', url: 'u' }), a.findingFingerprint({ title: 'Slow load: 6100 ms', url: 'u' }));
    assert.notEqual(a.findingFingerprint({ title: 'Broken image', url: 'u', detail: '/a.png' }), a.findingFingerprint({ title: 'Broken image', url: 'u', detail: '/b.png' }));
    assert.equal(a.findingFingerprint({ title: 'x 1', key: 'k' }), a.findingFingerprint({ title: 'totally different', key: 'k' }));
    const otherSite = a.child({ site: 't' });
    assert.notEqual(a.findingFingerprint({ title: 'same' }), otherSite.findingFingerprint({ title: 'same' }));
  });

  test('writes valid JSON lines with run id, context and sequence', () => {
    const file = path.join(tmp(), 'nested', 'events.jsonl');
    const log = new logger.Logger({ runId: 'r1', file }).child({ site: 's', category: 'seo', check: 'c' });
    log.finding({ severity: 'high', title: 't', url: 'https://x', key: 'k' });
    log.metric('lcp', 1234.5678, { unit: 'ms', url: 'https://x', budget: 2500 });
    log.metric('nan', Number.NaN);
    assert.throws(() => log.finding({ severity: 'severe', title: 'bad' }));
    const { events, invalid } = parseEvents(fs.readFileSync(file, 'utf8'));
    assert.equal(invalid, 0);
    assert.deepEqual(events.map((e) => e.type), ['finding', 'metric']);
    assert.equal(events[0].runId, 'r1');
    assert.equal(events[0].site, 's');
    assert.equal(events[1].value, 1234.568);
    assert.ok(events[1].seq > events[0].seq);
  });

  test('parallel processes appending to one file never interleave lines', async () => {
    const file = path.join(tmp(), 'events.jsonl');
    const script = `const { Logger } = require(${JSON.stringify(LOGGER)});
      const log = new Logger({ runId: 'r', file: ${JSON.stringify(file)}, context: { site: 's', category: 'c', check: 'k' } });
      for (let i = 0; i < 400; i++) log.finding({ severity: 'low', title: 'x'.repeat(200 + (i % 50)), detail: 'd'.repeat(1500), key: String(i) });`;
    await Promise.all(Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', script], { stdio: 'inherit' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer exited with ${code}`))));
    })));
    const { events, invalid } = parseEvents(fs.readFileSync(file, 'utf8'));
    assert.equal(invalid, 0);
    assert.equal(events.length, 4 * 400);
  });

  test('saveArtifact keeps files inside the run directory', () => {
    const dir = tmp();
    const log = new logger.Logger({ runId: 'r', file: path.join(dir, 'events.jsonl') });
    const e = log.saveArtifact('screenshot', '../../evil/../x shot.png', Buffer.from('png'));
    assert.equal(e.path, 'artifacts/evil/x_shot.png');
    assert.ok(fs.existsSync(path.join(dir, 'artifacts', 'evil', 'x_shot.png')));
  });

  test('categoryOf', () => {
    assert.equal(logger.categoryOf('/x/tests/qa/seo.spec.ts'), 'seo');
    assert.equal(logger.categoryOf('/x/tests/flows/mydubai-travel/home.spec.ts'), 'flows');
    assert.equal(logger.categoryOf('C:\\x\\tests\\security\\headers.spec.ts'.split('\\').join('/')), 'headers');
  });
});
