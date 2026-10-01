import AxeBuilder from '@axe-core/playwright';
import { test } from '../../lib/fixtures';
import { auditPages } from '../../lib/pages';
import type { Severity } from '../../lib/findings';

test.setTimeout(10 * 60_000);

const IMPACT: Record<string, Severity> = { critical: 'high', serious: 'medium', moderate: 'low', minor: 'info' };

test('WCAG 2.1 AA accessibility (axe-core)', async ({ page, request, site, findings }) => {
  for (const url of await auditPages(request, site)) {
    await test.step(url, async () => {
      const res = await page.goto(url, { waitUntil: 'load', timeout: 45_000 }).catch(() => null);
      if (!res?.ok()) return;
      const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
      for (const v of results.violations) {
        findings.add(IMPACT[v.impact ?? 'minor'] ?? 'low', `A11y: ${v.help} (${v.nodes.length} element${v.nodes.length > 1 ? 's' : ''})`, {
          url,
          detail: v.nodes.slice(0, 5).map((n) => n.target.join(' ')).join('\n'),
          fix: v.helpUrl,
        });
      }
    });
  }
});
