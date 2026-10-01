// Builders for synthetic event streams used by the unit tests.
let clock = Date.parse('2026-10-01T03:00:00.000Z');
let seq = 0;

export function run(runId, { source = 'local', sites = ['a', 'b'], start = clock, expect } = {}) {
  let t = start;
  const events = [];
  const push = (type, data) => {
    t += 1000;
    events.push({ v: 1, ts: new Date(t).toISOString(), runId, pid: 1, seq: ++seq, type, ...data });
    return api;
  };
  const api = {
    events,
    start() {
      return push('run.start', { source, sites: sites.map((name) => ({ name, baseUrl: `https://${name}.example` })), failOn: 'high', expect });
    },
    check(site, category, check, { status = 'passed', completed = status === 'passed', findings = [] } = {}) {
      push('check.start', { site, category, check });
      for (const f of findings) push('finding', { site, category, check, source: 'playwright', ...f });
      return push('check.end', { site, category, check, status, completed, durationMs: 10 });
    },
    startOnly(site, category, check) {
      return push('check.start', { site, category, check });
    },
    phase() {
      return push('run.phase', { phase: 'playwright' });
    },
    end(payload = {}) {
      return push('run.end', payload);
    },
  };
  clock = start + 3_600_000;
  return api;
}

export const f = (fp, severity = 'medium', title = `finding ${fp}`) => ({ fp, severity, title });
