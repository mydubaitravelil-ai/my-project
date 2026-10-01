import tls from 'node:tls';
import { test } from '../../lib/fixtures';

function tlsProbe(host: string, opts: tls.ConnectionOptions = {}): Promise<{ cert?: tls.PeerCertificate; protocol?: string | null; authorized?: boolean; error?: string }> {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: 15_000, ...opts }, () => {
      resolve({ cert: s.getPeerCertificate(), protocol: s.getProtocol(), authorized: s.authorized, error: s.authorizationError?.toString() });
      s.end();
    });
    s.on('error', (e) => resolve({ error: e.message }));
    s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }); });
  });
}

test('TLS certificate and protocol', async ({ site, findings }) => {
  const host = new URL(site.baseUrl).hostname;
  const r = await tlsProbe(host);
  if (!r.cert?.valid_to) return findings.critical('Could not establish a TLS connection', { url: site.baseUrl, detail: r.error });

  if (!r.authorized) findings.critical('TLS certificate is not trusted', { url: site.baseUrl, detail: r.error, fix: 'Install a valid certificate chain (e.g. Let\'s Encrypt / Cloudflare) including intermediates.' });
  const days = Math.floor((new Date(r.cert.valid_to).getTime() - Date.now()) / 86_400_000);
  if (days < 0) findings.critical(`TLS certificate EXPIRED ${-days} days ago`, { url: site.baseUrl });
  else if (days < 14) findings.high(`TLS certificate expires in ${days} days`, { url: site.baseUrl, fix: 'Renew now and verify auto-renewal works.' });
  else if (days < 30) findings.medium(`TLS certificate expires in ${days} days`, { url: site.baseUrl });
  findings.info(`Certificate: ${r.cert.subject?.CN} by ${r.cert.issuer?.O ?? r.cert.issuer?.CN}, valid until ${r.cert.valid_to} (${days} days), ${r.protocol}`);

  for (const v of ['TLSv1', 'TLSv1.1'] as const) {
    const old = await tlsProbe(host, { minVersion: v, maxVersion: v, ciphers: 'DEFAULT@SECLEVEL=0' });
    if (old.protocol === v) findings.medium(`Server still accepts deprecated ${v}`, { url: site.baseUrl, fix: 'Allow only TLS 1.2 and 1.3.' });
  }
  if (r.protocol && !['TLSv1.2', 'TLSv1.3'].includes(r.protocol)) findings.high(`Negotiated weak protocol ${r.protocol}`);
});

test('HTTP redirects to HTTPS and HSTS', async ({ request, site, findings }) => {
  const httpUrl = site.baseUrl.replace(/^https:/, 'http:') + '/';
  const res = await request.get(httpUrl, { maxRedirects: 0, timeout: 20_000 }).catch(() => null);
  if (res) {
    const loc = res.headers()['location'] ?? '';
    if (res.status() < 300 || res.status() >= 400) findings.high(`HTTP is served without redirecting to HTTPS (status ${res.status()})`, { url: httpUrl, fix: 'Add a permanent 301 redirect from http:// to https://.' });
    else if (!loc.startsWith('https://')) findings.high('HTTP redirects, but not to HTTPS', { url: httpUrl, detail: `Location: ${loc}` });
    else if (res.status() === 302 || res.status() === 307) findings.low('HTTP → HTTPS redirect is temporary (302/307); use 301', { url: httpUrl });
  }

  const https = await request.get(site.baseUrl + '/', { timeout: 30_000 });
  const hsts = https.headers()['strict-transport-security'] ?? '';
  if (!hsts) return findings.medium('Missing Strict-Transport-Security (HSTS)', { url: site.baseUrl, fix: 'Strict-Transport-Security: max-age=31536000; includeSubDomains' });
  const maxAge = Number(hsts.match(/max-age=(\d+)/i)?.[1] ?? 0);
  if (maxAge < 15_552_000) findings.low(`HSTS max-age is short (${maxAge}s, recommended ≥ 1 year)`, { url: site.baseUrl });

  const host = new URL(site.baseUrl).hostname;
  const alt = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  const altRes = await request.get(`https://${alt}/`, { maxRedirects: 0, timeout: 20_000 }).catch(() => null);
  if (altRes && altRes.status() === 200) findings.low(`Both ${host} and ${alt} serve content (duplicate site) — redirect one to the other`, { url: `https://${alt}/` });
});
