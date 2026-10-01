import { test } from '../../lib/fixtures';
import { extractLinks, sameSite } from '../../lib/pages';

test.setTimeout(15 * 60_000);

/** Runs fn over items with a small concurrency limit (polite to the server). */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: limit }, async () => {
    while (queue.length) await fn(queue.shift()!);
  }));
}

test('crawl internal pages and verify links', async ({ request, site, findings, log }) => {
  const visited = new Map<string, number>();
  const referrer = new Map<string, string>();
  const external = new Map<string, string>();
  const assets = new Map<string, string>();
  let frontier = [site.baseUrl + '/'];

  while (frontier.length && visited.size < site.maxCrawlPages) {
    const batch = frontier.splice(0, site.maxCrawlPages - visited.size).filter((u) => !visited.has(u));
    const next: string[] = [];
    await pool(batch, 4, async (url) => {
      if (visited.has(url)) return;
      visited.set(url, 0);
      const res = await request.get(url, { timeout: 30_000, maxRedirects: 5 }).catch(() => null);
      const status = res?.status() ?? 0;
      visited.set(url, status);
      const from = referrer.get(url);
      // Keyed by target URL: the referrer found first can differ between runs.
      if (!res) return findings.high('Internal page unreachable', { url, detail: from && `Linked from ${from}`, key: `unreachable|${url}` });
      if (status >= 500) return findings.high(`Internal page returns ${status}`, { url, detail: from && `Linked from ${from}`, key: `5xx|${url}` });
      if (status >= 400) return findings.high(`Broken internal link (${status})`, {
        url, detail: from && `Linked from ${from}`, key: `broken|${url}`, fix: 'Fix or remove the link, or add a 301 redirect to the new location.',
      });
      if (!sameSite(site, res.url())) return;
      if (!(res.headers()['content-type'] ?? '').includes('text/html')) return;
      const links = extractLinks(await res.text(), res.url());
      for (const l of links.pages) {
        if (sameSite(site, l)) {
          if (!visited.has(l) && !referrer.has(l)) { referrer.set(l, url); next.push(l); }
        } else if (!external.has(l)) external.set(l, url);
      }
      for (const a of links.assets) if (sameSite(site, a) && !assets.has(a)) assets.set(a, url);
    });
    frontier = [...new Set(next)];
  }

  log.metric('pagesCrawled', visited.size, { url: site.baseUrl });
  log.metric('externalLinks', external.size, { url: site.baseUrl });
  log.metric('ownAssets', assets.size, { url: site.baseUrl });
  log.info(`Crawled ${visited.size} internal pages; ${external.size} external links, ${assets.size} own assets`);

  await pool([...assets.entries()].slice(0, 200), 6, async ([url, from]) => {
    const res = await request.head(url, { timeout: 20_000 }).catch(() => null);
    const status = res?.status() ?? 0;
    if (status === 405 || status === 0) return; // some servers reject HEAD
    if (status >= 400) findings.medium(`Broken asset (${status})`, { url, detail: `Referenced from ${from}`, key: `asset|${url}` });
  });

  await pool([...external.entries()].slice(0, site.maxExternalLinks), 6, async ([url, from]) => {
    let res = await request.head(url, { timeout: 20_000 }).catch(() => null);
    if (!res || res.status() >= 400) res = await request.get(url, { timeout: 20_000 }).catch(() => null);
    const status = res?.status() ?? 0;
    // 401/403/429/999 usually mean the remote blocks bots, not that the link is dead.
    if ([401, 403, 429, 999].includes(status)) return;
    if (!res) findings.low('External link unreachable', { url, detail: `Linked from ${from}`, key: `external|${url}` });
    else if (status >= 400) findings.low(`Broken external link (${status})`, { url, detail: `Linked from ${from}`, key: `external|${url}` });
  });
});
