import fs from 'node:fs';
import path from 'node:path';

export interface Budgets {
  loadMs: number;
  ttfbMs: number;
  fcpMs: number;
  lcpMs: number;
  cls: number;
  pageWeightKb: number;
  requestCount: number;
  imageKb: number;
}

export interface Site {
  name: string;
  baseUrl: string;
  criticalPaths: string[];
  maxCrawlPages: number;
  maxExternalLinks: number;
  auditPages: number;
  budgets: Budgets;
}

interface SitesFile {
  sites: Array<Partial<Site> & { name: string; baseUrl: string }>;
  defaults: Omit<Site, 'name' | 'baseUrl' | 'criticalPaths'>;
}

/** Loads sites.json (or $SITES_FILE), merges defaults, and applies the optional $SITE filter. */
export function loadSites(): Site[] {
  const file = process.env.SITES_FILE ?? path.join(__dirname, '..', 'sites.json');
  const raw: SitesFile = JSON.parse(fs.readFileSync(file, 'utf8'));
  const only = process.env.SITE?.split(',').map((s) => s.trim());
  return raw.sites
    .filter((s) => !only || only.includes(s.name))
    .map((s) => ({
      ...raw.defaults,
      ...s,
      baseUrl: s.baseUrl.replace(/\/+$/, ''),
      criticalPaths: s.criticalPaths?.length ? s.criticalPaths : ['/'],
      budgets: { ...raw.defaults.budgets, ...(s.budgets ?? {}) },
    }));
}

export function absolute(site: Site, p: string): string {
  return new URL(p, site.baseUrl + '/').toString();
}
