// Where OWASP ZAP may run, and how hard. Used by CI (scripts/zap-targets.mjs) and locally (scripts/zap.mjs).
//   baseline (passive: spider + passive rules) → any site in sites.json, production included.
//   full     (ACTIVE: sends attack payloads)   → only a site's stagingUrl or a local address. Never production.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export function loadSitesConfig(file = process.env.SITES_FILE ?? path.join(ROOT, 'sites.json')) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const trim = (u) => (u ? String(u).replace(/\/+$/, '') : null);
  return raw.sites.map((s) => ({ name: s.name, baseUrl: trim(s.baseUrl), stagingUrl: trim(s.stagingUrl) }));
}

const bareHost = (url) => new URL(url).hostname.toLowerCase().replace(/^www\./, '');

export function isProductionUrl(url, sites) {
  const host = bareHost(url);
  return sites.some((s) => bareHost(s.baseUrl) === host);
}

export function isStagingUrl(url, sites) {
  const host = new URL(url).host.toLowerCase();
  return sites.some((s) => s.stagingUrl && new URL(s.stagingUrl).host.toLowerCase() === host);
}

export function isLocalUrl(url) {
  const host = new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'].includes(host)) return true;
  if (/\.(localhost|local|test|internal)$/.test(host)) return true;
  const ip = host.match(/^(\d+)\.(\d+)\.\d+\.\d+$/);
  if (!ip) return false;
  const [a, b] = [Number(ip[1]), Number(ip[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/** Throws unless a ZAP scan of `url` in `mode` is allowed by the policy above. */
export function assertZapAllowed({ mode, url, sites, allowLocal = true }) {
  if (!['baseline', 'full'].includes(mode)) throw new Error(`Unknown ZAP mode "${mode}" (use baseline or full)`);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL "${url}"`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`Only http(s) targets can be scanned, got "${url}"`);
  const local = allowLocal && isLocalUrl(url);
  if (mode === 'baseline') {
    if (isProductionUrl(url, sites) || isStagingUrl(url, sites) || local) return;
    throw new Error(`Refusing to scan ${url}: it is not a site (or staging copy) listed in sites.json.`);
  }
  if (isProductionUrl(url, sites)) {
    throw new Error(`Refusing an ACTIVE (full) scan of production ${url}. Full scans run only against a site's stagingUrl in sites.json or a local address.`);
  }
  if (isStagingUrl(url, sites) || local) return;
  throw new Error(`Refusing an ACTIVE (full) scan of ${url}: it is neither a stagingUrl in sites.json nor a local address.`);
}

/** CI matrix: baseline → every site's live URL; full → staging URLs only (sites without one are skipped). */
export function zapTargets({ mode, sites, only }) {
  const names = only ? only.split(',').map((n) => n.trim()).filter(Boolean) : null;
  const selected = sites.filter((s) => !names || names.includes(s.name));
  if (mode === 'baseline') return selected.map((s) => ({ name: s.name, url: s.baseUrl, mode }));
  if (mode === 'full') {
    return selected
      .filter((s) => s.stagingUrl)
      .map((s) => {
        assertZapAllowed({ mode, url: s.stagingUrl, sites, allowLocal: false });
        return { name: s.name, url: s.stagingUrl, mode };
      });
  }
  return [];
}
