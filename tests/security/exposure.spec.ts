import { test } from '../../lib/fixtures';
import { absolute } from '../../lib/site';
import type { Severity } from '../../lib/findings';

/** Well-known sensitive paths, each confirmed by a content signature to avoid soft-404 false positives. */
const PROBES: Array<{ path: string; sig: RegExp; severity: Severity; title: string }> = [
  { path: '/.git/HEAD', sig: /^ref: refs\//m, severity: 'critical', title: 'Git repository exposed (source code & secrets downloadable)' },
  { path: '/.git/config', sig: /\[core\]/, severity: 'critical', title: 'Git config exposed' },
  { path: '/.env', sig: /^[A-Z_]{3,}=.*/m, severity: 'critical', title: '.env file exposed (credentials/API keys)' },
  { path: '/.env.production', sig: /^[A-Z_]{3,}=.*/m, severity: 'critical', title: '.env.production exposed' },
  { path: '/.env.local', sig: /^[A-Z_]{3,}=.*/m, severity: 'critical', title: '.env.local exposed' },
  { path: '/backup.sql', sig: /(CREATE TABLE|INSERT INTO)/i, severity: 'critical', title: 'Database dump exposed' },
  { path: '/dump.sql', sig: /(CREATE TABLE|INSERT INTO)/i, severity: 'critical', title: 'Database dump exposed' },
  { path: '/db.sql', sig: /(CREATE TABLE|INSERT INTO)/i, severity: 'critical', title: 'Database dump exposed' },
  { path: '/.vscode/sftp.json', sig: /"(host|password)"/, severity: 'critical', title: 'SFTP credentials file exposed' },
  { path: '/config.php.bak', sig: /<\?php|password/i, severity: 'critical', title: 'Config backup exposed' },
  { path: '/wp-config.php.bak', sig: /DB_PASSWORD/, severity: 'critical', title: 'WordPress config backup exposed' },
  { path: '/.htpasswd', sig: /^\w+:\$?[\w./$]+/m, severity: 'critical', title: '.htpasswd exposed' },
  { path: '/.aws/credentials', sig: /aws_access_key_id/i, severity: 'critical', title: 'AWS credentials exposed' },
  { path: '/.svn/entries', sig: /^\d+\s*$|svn:/m, severity: 'high', title: 'SVN metadata exposed' },
  { path: '/phpinfo.php', sig: /phpinfo\(\)|PHP Version/i, severity: 'high', title: 'phpinfo() page exposed' },
  { path: '/info.php', sig: /phpinfo\(\)|PHP Version/i, severity: 'high', title: 'phpinfo() page exposed' },
  { path: '/server-status', sig: /Apache Server Status/i, severity: 'medium', title: 'Apache server-status exposed' },
  { path: '/elmah.axd', sig: /Error Log for/i, severity: 'high', title: 'ELMAH error log exposed' },
  { path: '/web.config', sig: /<configuration/i, severity: 'high', title: 'web.config exposed' },
  { path: '/.DS_Store', sig: /Bud1/, severity: 'low', title: '.DS_Store exposed (file listing leak)' },
  { path: '/composer.json', sig: /"require"/, severity: 'low', title: 'composer.json exposed (dependency versions)' },
  { path: '/package.json', sig: /"dependencies"/, severity: 'low', title: 'package.json exposed (dependency versions)' },
  { path: '/debug.log', sig: /(PHP (Fatal|Warning|Notice)|Stack trace|\[error\])/i, severity: 'high', title: 'Debug log exposed' },
  { path: '/error_log', sig: /(PHP (Fatal|Warning|Notice)|\[error\])/i, severity: 'high', title: 'error_log exposed' },
  { path: '/wp-content/debug.log', sig: /PHP (Fatal|Warning|Notice)/i, severity: 'high', title: 'WordPress debug.log exposed' },
];

const LISTING_DIRS = ['/uploads/', '/images/', '/img/', '/assets/', '/files/', '/backup/', '/wp-content/uploads/', '/static/'];

const ADMIN_PATHS = ['/admin', '/administrator', '/wp-admin/', '/wp-login.php', '/login', '/cpanel', '/phpmyadmin/', '/adminer.php', '/dashboard'];

test('sensitive files are not publicly accessible', async ({ request, site, findings }) => {
  for (const p of PROBES) {
    const url = absolute(site, p.path);
    const res = await request.get(url, { maxRedirects: 0, timeout: 15_000 }).catch(() => null);
    if (res?.status() === 200 && p.sig.test((await res.text()).slice(0, 20_000)))
      findings.add(p.severity, p.title, { url, fix: 'Block access in the web server config and move the file out of the web root. Rotate any secret it contained.' });
  }
});

test('no open directory listings', async ({ request, site, findings }) => {
  for (const d of LISTING_DIRS) {
    const url = absolute(site, d);
    const res = await request.get(url, { timeout: 15_000 }).catch(() => null);
    if (res?.status() === 200 && /<title>Index of \/|Directory listing for|\[To Parent Directory\]/i.test(await res.text()))
      findings.medium('Directory listing enabled', { url, fix: 'nginx: autoindex off; Apache: Options -Indexes' });
  }
});

test('admin / login surfaces inventory', async ({ request, site, findings }) => {
  for (const p of ADMIN_PATHS) {
    const url = absolute(site, p);
    const res = await request.get(url, { maxRedirects: 3, timeout: 15_000 }).catch(() => null);
    if (!res || res.status() !== 200) continue;
    const body = await res.text();
    if (/phpMyAdmin|Adminer/i.test(body)) findings.high('Database admin tool publicly reachable', { url, fix: 'Restrict by IP / VPN or remove it.' });
    else if (/type=["']?password/i.test(body)) findings.info('Public login page found — make sure it has rate-limiting, 2FA and lockout', { url });
  }
  const sec = await request.get(absolute(site, '/.well-known/security.txt')).catch(() => null);
  if (!sec?.ok() || !/contact:/i.test(await sec.text())) findings.info('No /.well-known/security.txt (vulnerability disclosure contact)', { fix: 'https://securitytxt.org' });
});
