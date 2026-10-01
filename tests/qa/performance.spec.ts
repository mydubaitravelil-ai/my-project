import { test } from '../../lib/fixtures';
import { absolute } from '../../lib/site';
import { sameSite } from '../../lib/pages';

test.setTimeout(5 * 60_000);

test('Core Web Vitals & page weight', async ({ page, site, findings, log }) => {
  await page.addInitScript(() => {
    (window as any).__vitals = { lcp: 0, cls: 0 };
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) (window as any).__vitals.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as any[]) if (!e.hadRecentInput) (window as any).__vitals.cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });

  const b = site.budgets;
  for (const p of site.criticalPaths) {
    const url = absolute(site, p);
    await test.step(url, async () => {
      const responses: Array<{ url: string; type: string; size: number; headers: Record<string, string> }> = [];
      const onResponse = async (r: any) => {
        const size = Number(r.headers()['content-length'] ?? 0) || (await r.body().catch(() => Buffer.alloc(0))).length;
        responses.push({ url: r.url(), type: r.request().resourceType(), size, headers: r.headers() });
      };
      page.on('response', onResponse);
      const res = await page.goto(url, { waitUntil: 'load', timeout: 60_000 }).catch(() => null);
      if (!res?.ok()) { page.off('response', onResponse); return; }
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await page.mouse.move(1, 1); // finalise LCP
      const m = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? 0;
        return { ttfb: nav.responseStart, fcp, load: nav.loadEventEnd, ...(window as any).__vitals };
      });
      page.off('response', onResponse);

      const fmt = (n: number) => Math.round(n);
      const totalKb = responses.reduce((s, r) => s + r.size, 0) / 1024;
      log.metric('ttfb', m.ttfb, { unit: 'ms', url, budget: b.ttfbMs });
      log.metric('fcp', m.fcp, { unit: 'ms', url, budget: b.fcpMs });
      log.metric('lcp', m.lcp, { unit: 'ms', url, budget: b.lcpMs });
      log.metric('cls', m.cls, { url, budget: b.cls });
      log.metric('requests', responses.length, { url, budget: b.requestCount });
      log.metric('pageWeightKb', totalKb, { unit: 'KB', url, budget: b.pageWeightKb });
      const budget = (val: number, max: number, name: string, fix: string) => {
        if (val > max * 1.6) findings.medium(`${name} ${fmt(val)} ms (budget ${max} ms)`, { url, fix });
        else if (val > max) findings.low(`${name} ${fmt(val)} ms (budget ${max} ms)`, { url, fix });
      };
      budget(m.ttfb, b.ttfbMs, 'Slow TTFB', 'Server-side caching, CDN, faster hosting, fewer DB queries per request.');
      budget(m.fcp, b.fcpMs, 'Slow First Contentful Paint', 'Inline critical CSS, defer non-critical JS, preload fonts.');
      budget(m.lcp, b.lcpMs, 'Slow Largest Contentful Paint', 'Compress/resize the hero image, serve WebP/AVIF, add fetchpriority="high" to the LCP image.');
      if (m.cls > b.cls * 2.5) findings.medium(`High layout shift CLS ${m.cls.toFixed(3)}`, { url, fix: 'Set width/height on images, reserve space for banners/embeds.' });
      else if (m.cls > b.cls) findings.low(`Layout shift CLS ${m.cls.toFixed(3)} (budget ${b.cls})`, { url });

      if (totalKb > b.pageWeightKb) findings.medium(`Heavy page: ${Math.round(totalKb)} KB (budget ${b.pageWeightKb} KB)`, { url });
      if (responses.length > b.requestCount) findings.low(`${responses.length} requests (budget ${b.requestCount})`, { url });

      for (const r of responses.filter((r) => r.type === 'image' && r.size / 1024 > b.imageKb).slice(0, 10))
        findings.low(`Oversized image ${Math.round(r.size / 1024)} KB`, { url, detail: r.url, fix: 'Resize to display size and convert to WebP/AVIF.' });

      const enc = res.headers()['content-encoding'] ?? '';
      if (!/(br|gzip|zstd)/.test(enc)) findings.medium('HTML is served without compression (gzip/brotli)', { url, fix: 'Enable gzip/brotli on the web server or CDN.' });
      const uncachedStatic = responses.filter((r) =>
        sameSite(site, r.url) && ['script', 'stylesheet', 'image', 'font'].includes(r.type) &&
        !/max-age=\d{4,}|immutable/.test(r.headers['cache-control'] ?? ''));
      if (uncachedStatic.length) findings.low(`${uncachedStatic.length} static asset(s) without long cache headers`, {
        url, detail: uncachedStatic.slice(0, 8).map((r) => r.url).join('\n'), key: `uncached-static|${url}`, fix: 'Cache-Control: public, max-age=31536000, immutable for fingerprinted assets.',
      });
    });
  }
});
