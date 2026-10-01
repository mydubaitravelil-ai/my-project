import type { APIRequestContext } from '@playwright/test';
import { absolute, type Site } from './site';

const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|css|js|mjs|json|xml|txt|zip|rar|mp4|mp3|webm|woff2?|ttf|eot|docx?|xlsx?)(\?|$)/i;

/** Extracts link targets from raw HTML: <a href> → pages, everything else → assets. */
export function extractLinks(html: string, pageUrl: string): { pages: string[]; assets: string[] } {
  const pages = new Set<string>();
  const assets = new Set<string>();
  for (const [tag, name] of html.matchAll(/<(a|link|script|img|source|iframe|video|audio)\b[^>]*>/gi)) {
    const attr = tag.match(/\b(?:href|src)\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    if (!attr || attr.startsWith('#') || /^(mailto:|tel:|javascript:|data:|whatsapp:|sms:)/i.test(attr)) continue;
    let u: URL;
    try {
      u = new URL(attr.replace(/&amp;/g, '&'), pageUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(u.protocol)) continue;
    u.hash = '';
    (name.toLowerCase() === 'a' && !SKIP_EXT.test(u.pathname) ? pages : assets).add(u.toString());
  }
  return { pages: [...pages], assets: [...assets] };
}

export function sameSite(site: Site, url: string): boolean {
  const host = (h: string) => h.replace(/^www\./, '');
  return host(new URL(url).hostname) === host(new URL(site.baseUrl).hostname);
}

const cache = new Map<string, Promise<string[]>>();

/**
 * Pages to run per-page audits (SEO, a11y, forms) on: critical paths first,
 * then internal links found on the home page and in sitemap.xml.
 */
export function auditPages(request: APIRequestContext, site: Site): Promise<string[]> {
  if (!cache.has(site.name)) cache.set(site.name, discover(request, site));
  return cache.get(site.name)!;
}

async function discover(request: APIRequestContext, site: Site): Promise<string[]> {
  const out = new Set(site.criticalPaths.map((p) => absolute(site, p)));
  try {
    const home = await request.get(site.baseUrl + '/', { timeout: 30_000 });
    for (const p of extractLinks(await home.text(), home.url()).pages) if (sameSite(site, p)) out.add(p);
  } catch {}
  try {
    const sm = await request.get(absolute(site, '/sitemap.xml'), { timeout: 20_000 });
    if (sm.ok()) for (const [, loc] of (await sm.text()).matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      if (sameSite(site, loc) && !loc.endsWith('.xml')) out.add(loc);
    }
  } catch {}
  return [...out].slice(0, Math.max(site.auditPages, site.criticalPaths.length));
}
