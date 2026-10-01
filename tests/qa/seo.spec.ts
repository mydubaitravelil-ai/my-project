import { test } from '../../lib/fixtures';
import { absolute } from '../../lib/site';
import { auditPages } from '../../lib/pages';

test.setTimeout(10 * 60_000);

test('on-page SEO essentials', async ({ page, request, site, findings, log }) => {
  const titles = new Map<string, string[]>();
  const pages = await auditPages(request, site);
  log.metric('pagesAudited', pages.length, { url: site.baseUrl });
  for (const url of pages) {
    await test.step(url, async () => {
      const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => null);
      if (!res || !res.ok()) return;
      const d = await page.evaluate(() => {
        const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content?.trim() ?? '';
        return {
          title: document.title.trim(),
          description: meta('meta[name="description"]'),
          robots: meta('meta[name="robots"]').toLowerCase(),
          viewport: meta('meta[name="viewport"]'),
          h1: [...document.querySelectorAll('h1')].map((h) => h.textContent?.trim() ?? ''),
          lang: document.documentElement.lang,
          canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href ?? '',
          ogTitle: meta('meta[property="og:title"]'),
          ogImage: meta('meta[property="og:image"]'),
          imgNoAlt: [...document.images].filter((i) => !i.hasAttribute('alt')).map((i) => i.currentSrc || i.src).slice(0, 10),
          imgCount: document.images.length,
          structuredData: document.querySelectorAll('script[type="application/ld+json"]').length,
        };
      });
      const xRobots = (res.headers()['x-robots-tag'] ?? '').toLowerCase();

      if (d.robots.includes('noindex') || xRobots.includes('noindex'))
        findings.high('Page is set to noindex — hidden from Google', { url, fix: 'Remove noindex from production pages that should rank.' });
      if (!d.title) findings.medium('Missing <title>', { url });
      else if (d.title.length < 10 || d.title.length > 70) findings.low(`Title length ${d.title.length} chars (ideal 10–70)`, { url, detail: d.title, key: `title-length|${url}` });
      if (!d.description) findings.medium('Missing meta description', { url, fix: 'Add a unique 70–160 character description that sells the page.' });
      else if (d.description.length < 50 || d.description.length > 170) findings.low(`Meta description length ${d.description.length} chars (ideal 50–160)`, { url });
      if (!d.viewport) findings.high('Missing viewport meta — page is not mobile-friendly', { url, fix: '<meta name="viewport" content="width=device-width, initial-scale=1">' });
      if (d.h1.length === 0) findings.medium('No <h1> heading', { url });
      else if (d.h1.length > 1) findings.low(`${d.h1.length} <h1> headings (use exactly one)`, { url });
      if (!d.lang) findings.low('Missing <html lang> attribute', { url, fix: 'e.g. <html lang="he" dir="rtl"> or <html lang="en">' });
      if (!d.canonical) findings.low('Missing canonical link', { url });
      if (!d.ogTitle || !d.ogImage) findings.low('Missing Open Graph tags (og:title / og:image) — poor link previews on WhatsApp/Facebook', { url });
      if (d.imgNoAlt.length) findings.low(`${d.imgNoAlt.length} image(s) without alt text`, { url, detail: d.imgNoAlt.join('\n'), key: `img-no-alt|${url}` });
      if (!d.structuredData) findings.info('No structured data (JSON-LD)', { url, fix: 'Consider TravelAgency / Organization / Product schema for rich results.' });
      if (d.title) titles.set(d.title, [...(titles.get(d.title) ?? []), url]);
    });
  }
  for (const [title, urls] of titles) if (urls.length > 1) findings.low('Duplicate page title', { detail: `"${title}" on:\n${urls.join('\n')}` });
});

test('robots.txt and sitemap.xml', async ({ request, site, findings }) => {
  const robots = await request.get(absolute(site, '/robots.txt')).catch(() => null);
  const text = robots?.ok() ? await robots.text() : '';
  if (!robots?.ok()) findings.low('robots.txt missing', { url: absolute(site, '/robots.txt') });
  else if (/^\s*disallow:\s*\/\s*$/im.test(text) && /user-agent:\s*\*/i.test(text))
    findings.high('robots.txt blocks the entire site (Disallow: /)', { url: absolute(site, '/robots.txt') });

  const sitemapUrl = text.match(/^\s*sitemap:\s*(\S+)/im)?.[1] ?? absolute(site, '/sitemap.xml');
  const sm = await request.get(sitemapUrl).catch(() => null);
  if (!sm?.ok()) findings.medium('sitemap.xml missing', { url: sitemapUrl, fix: 'Generate a sitemap and submit it in Google Search Console.' });
  else if (!/<(urlset|sitemapindex)/.test(await sm.text())) findings.medium('sitemap.xml is not valid XML sitemap', { url: sitemapUrl });
});
