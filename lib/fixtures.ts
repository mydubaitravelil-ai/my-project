import { test as base, expect } from '@playwright/test';
import { categoryOf, getLogger, type Logger } from './logger.cjs';
import { Findings } from './findings';
import type { Site } from './site';

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

export const test = base.extend<{ site: Site; log: Logger; findings: Findings }>({
  site: async ({}, use, testInfo) => {
    await use(testInfo.project.metadata.site as Site);
  },
  log: async ({ site }, use, testInfo) => {
    await use(getLogger().child({ site: site.name, category: categoryOf(testInfo.file), check: testInfo.title }));
  },
  // Auto fixture: every check gets check.start / check.end events, even if it never touches `findings`.
  findings: [
    async ({ log }, use, testInfo) => {
      const started = Date.now();
      log.emit('check.start', { retry: testInfo.retry });
      const findings = new Findings(log);
      await use(findings);

      // testInfo.status here is the outcome of the check body itself (passed / failed / timedOut / skipped).
      const completed = testInfo.status === 'passed';
      const blocking = findings.blocking();
      log.emit('check.end', {
        status: completed && blocking.length ? 'failed' : testInfo.status,
        completed,
        blocking: blocking.length,
        durationMs: Date.now() - started,
        retry: testInfo.retry,
        error: completed
          ? undefined
          : testInfo.errors.map((e) => stripAnsi(e.message ?? e.value ?? '').split('\n').slice(0, 3).join(' ').trim()).join(' | ').slice(0, 1000) || testInfo.status,
      });

      if (findings.items.length) {
        await testInfo.attach('findings.json', { body: JSON.stringify(findings.items, null, 2), contentType: 'application/json' });
      }
      expect(
        blocking.map((b) => `[${b.severity}] ${b.title}${b.url ? ` — ${b.url}` : ''}`),
        `${blocking.length} blocking finding(s)`,
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
