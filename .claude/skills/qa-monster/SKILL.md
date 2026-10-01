---
name: qa-monster
description: Run, extend and triage the QA Monster audit — automated QA + security testing (Playwright, axe-core, OWASP ZAP, TLS/header/exposure checks) for the sites in sites.json (mydubai-travel.com, thailand-express.com). Use when asked to audit/scan/test a site, check site security or quality, explain or fix findings from a QA Monster report, add a new site or user-flow test, tune severity/budgets, or set up the scheduled run and email report.
---

# QA Monster — security & quality audit

A professional-grade audit bot. Each run grades every site on **Security** and **QA** (A+…F),
lists findings by severity with a concrete fix, diffs against the previous run (new / resolved),
and emails a self-contained HTML report.

## Ground rules (non-negotiable)

1. **Only audit sites the user owns or is explicitly authorized to test.** Sites live in `sites.json`.
   Before adding a domain, confirm the user owns it.
2. **Passive by default.** Playwright checks only read pages (GET/HEAD); forms are inspected, **never submitted**.
   ZAP runs in `baseline` (passive) mode on the schedule.
3. **ZAP `full` (active) scans** send attack payloads and can create junk data (form spam, DB rows) or trip a WAF.
   Run them only on explicit user request, ideally against staging, and warn the user first.
4. Never write exploit code, brute-force logins, or exfiltrate data. Findings describe the weakness and the fix.
5. Found a secret exposed (`.env`, `.git`, dumps)? Tell the user to **rotate it immediately** — blocking access is not enough.

## Layout

| Path | Purpose |
|---|---|
| `sites.json` | Sites, critical paths, crawl limits, performance budgets (per-site overrides allowed) |
| `lib/fixtures.ts` | `test` with `site` + `findings` fixtures; a test fails when it records findings ≥ `FAIL_ON` |
| `lib/findings.ts` | Finding model: `findings.high(title, { url, detail, fix })` etc. |
| `lib/pages.ts` | Link extraction + `auditPages()` (critical paths + home links + sitemap) |
| `tests/qa/*` | availability, links (crawler), seo, accessibility (axe WCAG 2.1 AA), performance (Web Vitals), responsive, forms |
| `tests/security/*` | transport (TLS, HTTPS, HSTS), headers (CSP, cookies, CORS, mixed content, outdated libs, error leaks), exposure (secrets files, listings, admin panels) |
| `tests/flows/<site>/*` | Site-specific user journeys — run only for that site |
| `scripts/build-report.mjs` | Merges findings + ZAP JSON → `reports/report.html`, `summary.md`, `summary.json`, grades |
| `.github/workflows/qa-monster.yml` | Daily schedule + manual run, ZAP matrix, email, Slack, tracking issue |
| `.zap/rules.tsv` | ZAP rule overrides (IGNORE/WARN/FAIL) |

## Running

```bash
npm ci && npx playwright install chromium     # once
npm run audit                                  # all sites, all checks
SITE=mydubai-travel npm run audit              # one site
npm run audit:security                         # security only
npm run report                                 # build reports/report.html from results
npm run audit:full                             # audit + report, exit 1 on blocking findings
FAIL_ON=medium npm run audit                   # stricter gate
```

In a Claude Code cloud session the environment's network policy may block the sites (proxy returns 403).
Then either ask the user to allow the domains (environment settings → Network access) or trigger the
GitHub workflow (`workflow_dispatch`) and read its `qa-monster-report` artifact.
For a local Chromium that differs from Playwright's, set `CHROMIUM_PATH`.

## Triage workflow (when the user asks "what's wrong / what should I fix")

1. Read `reports/summary.json` (or the artifact). Lead with grades and the count of critical/high.
2. Order: **critical → high → new (🆕) → medium**. Group by root cause (e.g. all missing headers = one server-config change).
3. For each item give: what it means in plain language, the real-world risk for a travel booking site
   (lead/payment data, reputation, SEO, conversions), and the exact fix — use `references/fix-recipes.md`.
4. Separate **false positives** honestly (e.g. third-party 403s, CSP set by a CDN that the probe missed) and suggest
   tuning (`.zap/rules.tsv`, budgets in `sites.json`) rather than hiding real issues.
5. If the user can share code/hosting details, propose the concrete patch.
6. Severity meanings and the scoring model: `references/severity.md`.

## Extending

- **New site:** append to `sites.json` → `{ "name": "...", "baseUrl": "https://...", "criticalPaths": ["/", "/contact"] }`
  and add `tests/flows/<name>/`. Confirm ownership first.
- **New user flow:** copy `tests/flows/mydubai-travel/home.spec.ts`. Use role/text locators, never submit real
  bookings/leads on production. If a flow must submit, use a dedicated test endpoint/account the user provides.
- **New check:** add a spec under `tests/qa` or `tests/security` using `import { test } from '../../lib/fixtures'`;
  record issues via `findings.<severity>(title, { url, detail, fix })` — always include `fix`. Category = file name;
  add a Hebrew label in `CAT_HE` in `scripts/build-report.mjs` and, if it's a security check, to `SECURITY_CATEGORIES`.
- Validate with `npm run typecheck` and a run against a local server (`SITES_FILE=... npx playwright test`).

## Report delivery

The workflow emails `report.html` when the repo has secrets `SMTP_USERNAME` + `SMTP_PASSWORD` (Gmail: an App Password)
and variable `REPORT_EMAIL`. Without them, the run still opens/updates a GitHub issue labelled `qa-monster`
(GitHub notifies the repo owner by email) and closes it when everything blocking is fixed.
Scheduled runs only fire from the default branch.
