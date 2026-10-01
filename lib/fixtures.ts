import path from 'node:path';
import { test as base, expect } from '@playwright/test';
import { Findings } from './findings';
import type { Site } from './site';

export const test = base.extend<{ site: Site; findings: Findings }>({
  site: async ({}, use, testInfo) => {
    await use(testInfo.project.metadata.site as Site);
  },
  findings: async ({ site }, use, testInfo) => {
    const category = path.basename(testInfo.file).replace(/\.spec\.ts$/, '');
    const f = new Findings(site.name, category, testInfo.title);
    await use(f);
    f.write();
    if (f.items.length) {
      await testInfo.attach('findings.json', { body: JSON.stringify(f.items, null, 2), contentType: 'application/json' });
    }
    const blocking = f.blocking();
    expect(
      blocking.map((b) => `[${b.severity}] ${b.title}${b.url ? ` — ${b.url}` : ''}`),
      `${blocking.length} blocking finding(s)`,
    ).toEqual([]);
  },
});

export { expect };
