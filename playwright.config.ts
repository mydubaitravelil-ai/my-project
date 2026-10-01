import { defineConfig, devices } from '@playwright/test';
import { loadSites } from './lib/site';

const sites = loadSites();

export default defineConfig({
  testDir: './tests',
  timeout: 3 * 60_000,
  fullyParallel: true,
  workers: process.env.CI ? 4 : 2,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: 'playwright-report' }],
    ['json', { outputFile: 'reports/playwright-results.json' }],
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
    // Site-specific user-flow specs live in tests/flows/<site-name>/ and only run for that site.
    testIgnore: sites.filter((s) => s.name !== site.name).map((s) => `**/flows/${s.name}/**`),
  })),
});
