import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  buildRunModel, computeDiff, buildCore, describeRun, grade, parseEvents, pickBaseline, runEndPayload, score,
} from '../../lib/model.mjs';
import { f, run } from './helpers.mjs';

describe('parsing and scoring', () => {
  test('parseEvents skips malformed lines and counts them', () => {
    const { events, invalid } = parseEvents('{"type":"run.start","runId":"r"}\nnot json\n\n{"no":"type"}\n{"type":"metric"}');
    assert.equal(events.length, 2);
    assert.equal(invalid, 2);
  });

  test('grade boundaries', () => {
    assert.deepEqual([100, 95, 94, 85, 84, 75, 60, 45, 44, 0].map(grade), ['A+', 'A+', 'A', 'A', 'B', 'B', 'C', 'D', 'F', 'F']);
    assert.equal(grade(null), '—');
  });

  test('score caps repeated penalties per category and severity', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ category: 'seo', severity: 'medium', fp: String(i) }));
    assert.equal(score(many), 100 - 4 * 3);
    assert.equal(score([{ category: 'x', severity: 'info' }]), 100);
    assert.equal(score(Array.from({ length: 5 }, () => ({ category: 'x', severity: 'critical' }))), 10);
  });
});

describe('run model', () => {
  test('duplicate fingerprints keep the most severe version', () => {
    const r = run('r1').start().check('a', 'seo', 'c', { findings: [f('x', 'low'), f('x', 'high')] }).end();
    const m = buildRunModel(r.events);
    assert.equal(m.findings.filter((x) => x.fp === 'x').length, 1);
    assert.equal(m.findings.find((x) => x.fp === 'x').severity, 'high');
  });

  test('crashed, timed-out and interrupted checks become "could not complete" findings; skipped does not', () => {
    const r = run('r1', { sites: ['a'] }).start()
      .check('a', 'seo', 'crash', { status: 'failed', completed: false })
      .check('a', 'links', 'slow', { status: 'timedOut', completed: false })
      .check('a', 'forms', 'skip', { status: 'skipped', completed: false })
      .check('a', 'headers', 'ok')
      .startOnly('a', 'exposure', 'killed')
      .end();
    const m = buildRunModel(r.events);
    const titles = m.findings.filter((x) => x.synthetic).map((x) => x.title).sort();
    assert.deepEqual(titles, [
      'Check could not complete: crash (failed)',
      'Check could not complete: killed (interrupted)',
      'Check could not complete: slow (timedOut)',
    ]);
  });

  test('a running run does not flag in-progress checks', () => {
    const r = run('r1', { sites: ['a'], start: Date.now() - 1000 }).start().startOnly('a', 'seo', 'busy');
    const m = buildRunModel(r.events, { now: Date.now() });
    assert.equal(m.status, 'running');
    assert.equal(m.findings.length, 0);
  });

  test('a silent run without an end marker becomes stale', () => {
    const r = run('r1', { sites: ['a'], start: Date.parse('2026-01-01T00:00:00Z') }).start().startOnly('a', 'seo', 'busy');
    assert.equal(describeRun(r.events, { now: Date.parse('2026-01-02T00:00:00Z') }).status, 'stale');
  });

  test('grades only for groups that ran; sites with no completed check get a high finding', () => {
    const r = run('r1', { sites: ['a', 'b'] }).start().check('a', 'headers', 'h', { findings: [f('h1', 'medium')] }).phase();
    const m = buildRunModel(r.events);
    const a = m.sites.find((s) => s.name === 'a');
    const b = m.sites.find((s) => s.name === 'b');
    assert.equal(a.securityScore, 96);
    assert.equal(a.qaGrade, '—');
    assert.equal(b.securityGrade, '—');
    assert.ok(b.findings.some((x) => x.fp === 'not-checked:b:all' && x.severity === 'high'));
    assert.ok(m.blocking.some((x) => x.site === 'b'));
  });

  test('expected check groups that did not run are reported', () => {
    const r = run('r1', { sites: ['a'], expect: ['qa', 'security'] }).start().check('a', 'zap', 'ZAP baseline scan').end();
    const m = buildRunModel(r.events);
    assert.ok(m.sites[0].findings.some((x) => x.fp === 'not-checked:a:qa'));
  });
});

describe('new vs resolved', () => {
  const base = () => run('base', { sites: ['a', 'b'] }).start()
    .check('a', 'seo', 'seo', { findings: [f('keep'), f('gone'), f('info', 'info')] })
    .check('b', 'links', 'links', { findings: [f('b-old')] })
    .end();

  test('new = absent last time from a check that completed then; resolved = absent now from a check that completed now', () => {
    const cur = run('cur', { sites: ['a', 'b'] }).start()
      .check('a', 'seo', 'seo', { findings: [f('keep'), f('fresh')] })
      .check('a', 'forms', 'forms', { findings: [f('no-baseline')] }) // check did not run in the baseline
      .phase();
    const m = buildRunModel(cur.events, { baselineEvents: base().events });
    const isNew = Object.fromEntries(m.findings.map((x) => [x.fp, x.isNew]));
    assert.equal(isNew.fresh, true);
    assert.equal(isNew.keep, false);
    assert.equal(isNew['no-baseline'], false, 'no baseline for this check → not "new"');
    assert.deepEqual(m.diff.resolved.map((x) => x.fp), ['gone'], 'b/links did not run now → b-old is not resolved; info is never tracked');
    const b = m.sites.find((s) => s.name === 'b');
    assert.equal(b.resolved.length, 0);
  });

  test('a check that crashed now does not resolve its old findings', () => {
    const cur = run('cur', { sites: ['a'] }).start().check('a', 'seo', 'seo', { status: 'failed', completed: false }).end();
    const diff = computeDiff(buildCore(cur.events), buildCore(base().events));
    assert.deepEqual(diff.resolved, []);
    assert.ok(diff.new.includes('incomplete:a|seo|seo'), 'a check that completed last time and crashed now is new');
  });

  test('a finalized run reuses the comparison stored in run.end', () => {
    const cur = run('cur', { sites: ['a'] }).start().check('a', 'seo', 'seo', { findings: [f('keep'), f('fresh')] }).phase();
    const live = buildRunModel(cur.events, { baselineEvents: base().events });
    cur.end(runEndPayload(live));
    const stored = buildRunModel(cur.events); // no baseline needed any more
    assert.equal(stored.diff.baselineRunId, 'base');
    assert.equal(stored.findings.find((x) => x.fp === 'fresh').isNew, true);
    assert.deepEqual(stored.diff.resolved.map((x) => x.fp), ['gone']);
    // recomputeDiff with another baseline overrides the stored one
    const other = run('other', { sites: ['a'] }).start().check('a', 'seo', 'seo', { findings: [f('fresh')] }).end();
    const re = buildRunModel(cur.events, { baselineEvents: other.events, recomputeDiff: true });
    assert.equal(re.findings.find((x) => x.fp === 'fresh').isNew, false);
  });

  test('pickBaseline: latest earlier finalized run from the same source', () => {
    const runs = [
      { runId: 'l1', source: 'local', finalized: true, startedAt: '2026-01-01' },
      { runId: 'l2', source: 'local', finalized: false, startedAt: '2026-01-02' },
      { runId: 'g1', source: 'github', finalized: true, startedAt: '2026-01-03' },
      { runId: 'l3', source: 'local', finalized: true, startedAt: '2026-01-04' },
    ];
    assert.equal(pickBaseline(runs, { runId: 'l4', source: 'local', startedAt: '2026-01-05' }).runId, 'l3');
    assert.equal(pickBaseline(runs, { runId: 'l3', source: 'local', startedAt: '2026-01-04' }).runId, 'l1');
    assert.equal(pickBaseline(runs, { runId: 'g2', source: 'github', startedAt: '2026-01-02' }), null);
  });
});
