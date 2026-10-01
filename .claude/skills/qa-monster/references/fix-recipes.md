# Fix recipes

## Security headers (all at once)

**nginx**
```nginx
server_tokens off;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "camera=(), microphone=(), geolocation=()" always;
add_header Content-Security-Policy-Report-Only "default-src 'self'; img-src 'self' data: https:; script-src 'self' https:; style-src 'self' 'unsafe-inline' https:; frame-ancestors 'self'; object-src 'none'; base-uri 'self'" always;
```

**Apache (.htaccess)**
```apache
Header always set Strict-Transport-Security "max-age=31536000; includeSubDomains"
Header always set X-Frame-Options "SAMEORIGIN"
Header always set X-Content-Type-Options "nosniff"
Header always set Referrer-Policy "strict-origin-when-cross-origin"
Header always set Permissions-Policy "camera=(), microphone=(), geolocation=()"
Header unset X-Powered-By
ServerSignature Off
```

**Node / Express:** `app.use(require('helmet')())`.
**Cloudflare:** Rules → Transform Rules → Modify Response Header; SSL/TLS → Edge Certificates → Always Use HTTPS + HSTS + Minimum TLS 1.2.

CSP rollout: ship `Content-Security-Policy-Report-Only` first, watch the console for a week (analytics, WhatsApp widgets,
Facebook pixel, payment iframes), then switch to the enforcing header.

## HTTPS
- nginx: `server { listen 80; server_name example.com www.example.com; return 301 https://example.com$request_uri; }`
- Apache: `RewriteEngine On` / `RewriteCond %{HTTPS} off` / `RewriteRule ^ https://%{HTTP_HOST}%{REQUEST_URI} [L,R=301]`
- Certificates: Let's Encrypt with `certbot renew` timer, or Cloudflare origin certs. Check renewal: `certbot renew --dry-run`.
- Disable TLS 1.0/1.1: nginx `ssl_protocols TLSv1.2 TLSv1.3;`

## Exposed files
- nginx: `location ~ /\.(?!well-known) { deny all; }` and `location ~* \.(sql|bak|log|env)$ { deny all; }`
- Apache: `<FilesMatch "^\.|\.(sql|bak|log|env)$"> Require all denied </FilesMatch>`
- Then **rotate every credential** that was in the file and check access logs for downloads of that path.

## Cookies
Session cookies: `Secure; HttpOnly; SameSite=Lax`. PHP: `session.cookie_secure=1`, `session.cookie_httponly=1`, `session.cookie_samesite=Lax`.

## Forms (travel lead forms)
- Bot protection: Cloudflare Turnstile (free) or reCAPTCHA v3 + a hidden honeypot field.
- Server-side: validate every field, rate-limit per IP (e.g. 5/min), CSRF token on POST, never trust client validation.
- Use `type="email"`, `type="tel"`, `autocomplete` attributes, `required` on mandatory fields.

## Performance
- Images: resize to display size, WebP/AVIF, `loading="lazy"` below the fold, `fetchpriority="high"` on the hero (LCP) image, always set `width`/`height` (CLS).
- Enable brotli/gzip; long cache on fingerprinted assets: `Cache-Control: public, max-age=31536000, immutable`.
- Defer third-party scripts (chat widgets, pixels) until after load.

## SEO
- One `<h1>`, unique `<title>` (10–70) and meta description (50–160) per page, canonical, `<html lang="he" dir="rtl">` / `lang="en"`.
- Open Graph (`og:title`, `og:description`, `og:image` 1200×630) — controls how links look on WhatsApp/Facebook.
- `robots.txt` with a `Sitemap:` line; submit sitemap in Google Search Console.
- JSON-LD `TravelAgency` / `Organization` + `Product`/`Offer` for packages.

## Accessibility
Follow the axe `helpUrl` in each finding. Most common: missing `alt`, unlabeled inputs, low color contrast,
buttons/links without accessible name, missing `lang`. Israeli law (תקנות נגישות השירות) requires WCAG 2.0 AA for most business sites.
