import { test } from '../../lib/fixtures';
import { absolute } from '../../lib/site';
import { sameSite } from '../../lib/pages';

test('critical pages load cleanly', async ({ page, site, findings }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const badResponses: Array<{ url: string; status: number }> = [];
  const failedRequests: Array<{ url: string; error: string }> = [];

  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('response', (r) => r.status() >= 400 && badResponses.push({ url: r.url(), status: r.status() }));
  page.on('requestfailed', (r) => failedRequests.push({ url: r.url(), error: r.failure()?.errorText ?? 'failed' }));

  for (const p of site.criticalPaths) {
    const url = absolute(site, p);
    await test.step(url, async () => {
      consoleErrors.length = pageErrors.length = badResponses.length = failedRequests.length = 0;
      const started = Date.now();
      let res;
      try {
        res = await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
      } catch (e) {
        findings.critical('Page did not load (timeout / network error)', {
          url,
          detail: String(e).slice(0, 400),
          fix: 'Check hosting/DNS/CDN health and server logs; verify the site is reachable from outside your network.',
        });
        return;
      }
      const elapsed = Date.now() - started;
      const status = res?.status() ?? 0;
      if (status >= 500) findings.critical(`Server error ${status}`, { url, fix: 'Inspect server/application logs for the failing request.' });
      else if (status >= 400) findings.high(`Critical page returns ${status}`, { url, fix: 'Restore the page or update the critical path list in sites.json.' });

      if (elapsed > site.budgets.loadMs * 2) findings.high(`Very slow load: ${elapsed} ms`, { url, detail: `Budget ${site.budgets.loadMs} ms` });
      else if (elapsed > site.budgets.loadMs) findings.medium(`Slow load: ${elapsed} ms`, { url, detail: `Budget ${site.budgets.loadMs} ms` });

      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

      const brokenImages = await page.$$eval('img', (imgs) =>
        imgs.filter((i) => i.complete && i.naturalWidth === 0 && (i.currentSrc || i.src)).map((i) => i.currentSrc || i.src),
      );
      for (const src of brokenImages.slice(0, 20)) findings.medium('Broken image', { url, detail: src, fix: 'Fix the image path or re-upload the file.' });

      for (const e of [...new Set(pageErrors)].slice(0, 10))
        findings.medium('Uncaught JavaScript exception', { url, detail: e.slice(0, 500), fix: 'Reproduce in DevTools console; an uncaught error can break interactive features.' });
      for (const e of [...new Set(consoleErrors)].slice(0, 10)) findings.low('Console error', { url, detail: e.slice(0, 500) });

      for (const r of badResponses.slice(0, 30)) {
        if (r.url === url) continue;
        const own = sameSite(site, r.url);
        findings.add(own ? 'medium' : 'low', `${own ? 'Own' : 'Third-party'} resource returns ${r.status}`, { url, detail: r.url });
      }
      for (const r of failedRequests.slice(0, 20)) {
        if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(r.error)) continue;
        findings.add(sameSite(site, r.url) ? 'medium' : 'low', `Request failed: ${r.error}`, { url, detail: r.url });
      }

      const title = await page.title();
      if (!title.trim()) findings.medium('Page has an empty <title>', { url });
      const bodyText = (await page.locator('body').innerText().catch(() => '')).trim();
      if (bodyText.length < 50) findings.high('Page renders (almost) no visible text — possible blank page', { url });
      if (/(fatal error|stack trace|traceback \(most recent call last\)|SQLSTATE\[|Warning: .* on line \d+|Uncaught exception)/i.test(bodyText))
        findings.high('Error / debug output visible on the page', { url, fix: 'Disable debug output in production and log errors server-side.' });
    });
  }
});

test('home page responds over plain HTTP request', async ({ request, site, findings }) => {
  const times: number[] = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const res = await request.get(site.baseUrl + '/', { timeout: 30_000 }).catch(() => null);
    times.push(Date.now() - t);
    if (!res) return findings.critical('Home page unreachable', { url: site.baseUrl });
    if (!res.ok()) return findings.critical(`Home page returns ${res.status()}`, { url: site.baseUrl });
  }
  const median = times.sort((a, b) => a - b)[1];
  if (median > site.budgets.ttfbMs * 2) findings.medium(`Slow server response: median ${median} ms over 3 requests`, {
    url: site.baseUrl,
    fix: 'Enable full-page caching / CDN, check slow DB queries and server resources.',
  });
});
