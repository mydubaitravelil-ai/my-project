import { test } from '../../lib/fixtures';
import { absolute } from '../../lib/site';

test('security headers', async ({ request, site, findings }) => {
  const url = site.baseUrl + '/';
  const res = await request.get(url, { timeout: 30_000 });
  const h = res.headers();
  const csp = h['content-security-policy'] ?? '';

  if (!csp) findings.medium('Missing Content-Security-Policy', {
    url, fix: "Start with Content-Security-Policy-Report-Only, then enforce. Minimum: frame-ancestors 'self'; object-src 'none'; base-uri 'self'",
  });
  else {
    if (/script-src[^;]*'unsafe-inline'/.test(csp) && !/'nonce-|'strict-dynamic'/.test(csp)) findings.low("CSP allows 'unsafe-inline' scripts — weak XSS protection", { url });
    if (/script-src[^;]*'unsafe-eval'/.test(csp)) findings.low("CSP allows 'unsafe-eval'", { url });
  }
  if (!h['x-frame-options'] && !/frame-ancestors/.test(csp)) findings.medium('No clickjacking protection (X-Frame-Options / frame-ancestors)', { url, fix: 'X-Frame-Options: SAMEORIGIN' });
  if ((h['x-content-type-options'] ?? '').toLowerCase() !== 'nosniff') findings.low('Missing X-Content-Type-Options: nosniff', { url });
  if (!h['referrer-policy']) findings.low('Missing Referrer-Policy', { url, fix: 'Referrer-Policy: strict-origin-when-cross-origin' });
  if (!h['permissions-policy']) findings.info('Missing Permissions-Policy', { url, fix: 'Permissions-Policy: camera=(), microphone=(), geolocation=()' });

  if (/\d/.test(h['server'] ?? '')) findings.low(`Server header discloses version: "${h['server']}"`, { url, fix: 'Hide versions (nginx: server_tokens off; Apache: ServerTokens Prod).' });
  for (const k of ['x-powered-by', 'x-aspnet-version', 'x-aspnetmvc-version', 'x-generator'])
    if (h[k]) findings.low(`Header ${k} discloses technology: "${h[k]}"`, { url, fix: `Remove the ${k} header.` });

  if (h['access-control-allow-origin'] === '*' && h['access-control-allow-credentials'] === 'true')
    findings.high('CORS allows any origin with credentials', { url });
  const probe = await request.get(url, { headers: { Origin: 'https://evil.example' } });
  if (probe.headers()['access-control-allow-origin'] === 'https://evil.example')
    findings[probe.headers()['access-control-allow-credentials'] === 'true' ? 'high' : 'medium']('CORS reflects arbitrary Origin', { url, fix: 'Allow-list specific origins only.' });
});

test('cookies, mixed content and third-party scripts', async ({ page, context, site, findings, log }) => {
  const insecure: string[] = [];
  page.on('request', (r) => r.url().startsWith('http://') && insecure.push(r.url()));
  await page.goto(site.baseUrl + '/', { waitUntil: 'load', timeout: 45_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

  if (site.baseUrl.startsWith('https://')) for (const u of [...new Set(insecure)].slice(0, 15)) findings.high('Mixed content: resource loaded over HTTP on an HTTPS page', { url: site.baseUrl, detail: u });

  const host = new URL(site.baseUrl).hostname.replace(/^www\./, '');
  for (const c of await context.cookies()) {
    if (!c.domain.replace(/^\./, '').endsWith(host)) continue; // own cookies only
    const sensitive = /sess|auth|token|sid|login|jwt|csrf|xsrf/i.test(c.name);
    if (!c.secure) findings.add(sensitive ? 'high' : 'low', `Cookie "${c.name}" missing Secure flag`, { url: site.baseUrl });
    if (sensitive && !c.httpOnly && !/csrf|xsrf/i.test(c.name)) findings.high(`Session-like cookie "${c.name}" readable by JavaScript (no HttpOnly)`, { url: site.baseUrl, fix: 'Set HttpOnly on session cookies to blunt XSS session theft.' });
    if (c.sameSite === 'None' && !c.secure) findings.medium(`Cookie "${c.name}" SameSite=None without Secure`, { url: site.baseUrl });
  }

  const scripts = await page.$$eval('script[src]', (s) => s.map((e) => ({ src: (e as HTMLScriptElement).src, sri: !!e.getAttribute('integrity') })));
  const thirdParty = scripts.filter((s) => !new URL(s.src).hostname.endsWith(host));
  const domains = [...new Set(thirdParty.map((s) => new URL(s.src).hostname))];
  log.metric('thirdPartyScriptDomains', domains.length, { url: site.baseUrl });
  if (domains.length) findings.info(`${domains.length} third-party script domain(s)`, { url: site.baseUrl, detail: domains.join('\n'), key: 'third-party-domains' });
  const cdnNoSri = thirdParty.filter((s) => !s.sri && /cdn|unpkg|jsdelivr|cdnjs|bootstrapcdn|jquery/i.test(s.src));
  if (cdnNoSri.length) findings.low('CDN scripts loaded without Subresource Integrity', { url: site.baseUrl, detail: cdnNoSri.map((s) => s.src).join('\n'), key: 'cdn-no-sri' });

  const libs = await page.evaluate(() => ({
    jquery: (window as any).jQuery?.fn?.jquery as string | undefined,
    bootstrap: (window as any).bootstrap?.Tooltip?.VERSION as string | undefined,
  }));
  if (libs.jquery && /^(1\.|2\.|3\.[0-4]\.)/.test(libs.jquery))
    findings.medium(`Outdated jQuery ${libs.jquery} with known XSS CVEs`, { url: site.baseUrl, fix: 'Upgrade to jQuery ≥ 3.5.0.' });
  if (libs.bootstrap && /^(3\.|4\.[0-2]\.)/.test(libs.bootstrap)) findings.low(`Outdated Bootstrap ${libs.bootstrap}`, { url: site.baseUrl });
});

test('error pages do not leak internals', async ({ request, site, findings }) => {
  // Fixed path (not a timestamp) so the finding keeps the same identity from run to run.
  const missing = absolute(site, '/qa-monster-404-probe-7f3a9c');
  const res = await request.get(missing, { timeout: 20_000 });
  if (res.status() === 200) findings.low('Unknown URLs return 200 instead of 404 (soft-404)', { url: missing, fix: 'Return a real 404 status for missing pages.' });
  const body = await res.text();
  const leak = body.match(/(Traceback \(most recent|Stack trace:|SQLSTATE\[|at [\w.$]+\(.*\.(java|cs|js):\d+\)|Warning: .{0,80} on line \d+|Fatal error:|DEBUG = True|Whoops!|Laravel|Django Version|Exception Details)/i);
  if (leak) findings.high('Error page leaks debug information', { url: missing, detail: leak[0], fix: 'Turn off debug mode in production and use a generic error page.' });

  const q = await request.get(site.baseUrl + "/?id=1'%22%3E", { timeout: 20_000 }).catch(() => null);
  if (q && q.status() >= 500) findings.medium(`Unexpected characters in a query string cause a ${q.status()} error`, { url: q.url(), fix: 'Validate/escape input; check server logs for the exception.' });
  const qb = q ? await q.text() : '';
  if (/SQLSTATE|mysql_|syntax error.*SQL|ORA-\d{5}|PG::|SQLite/i.test(qb)) findings.critical('Database error message exposed (possible SQL injection)', { url: q!.url() });
});
