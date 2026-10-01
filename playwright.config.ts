import { defineConfig, devices } from '@playwright/test';
import { ensureRunId } from './lib/logger.cjs';
import { loadSites } from './lib/site';

// One run id for the whole process tree; every event of this run goes to runs/<runId>/events.jsonl.
ensureRunId();
const sites = loadSites();

export default defineConfig({
  testDir: './tests',
  timeout: 3 * 60_000,
  fullyParallel: true,
  workers: process.env.CI ? 4 : 2,
  retries: 0,
  // Run lifecycle events come from global setup/teardown and the auto `findings` fixture, so they are
  // recorded whatever --reporter is used.
  globalSetup: './lib/global-setup.ts',
  globalTeardown: './lib/global-teardown.ts',
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
  ],
  use: {
    ...devices['Desktop Chrome'],
    ignoreHTTPSErrors: true, // TLS problems are reported by tests/security/transport.spec.ts instead
    userAgent: `${devices['Desktop Chrome'].userAgent} QA-Monster/1.0`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    actionTimeout: 20_000,
    navigationTimeout: 45_000,
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  },
  projects: sites.map((site) => ({
    name: site.name,
    metadata: { site },
    use: { baseURL: site.baseUrl },
    testIgnore: [
      '**/unit/**', // node:test unit tests (npm run test:unit)
      // Site-specific user-flow specs live in tests/flows/<site-name>/ and only run for that site.
      new RegExp(`[\\\\/]flows[\\\\/](?!${site.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\\\/])`),
    ],
  })),
});
