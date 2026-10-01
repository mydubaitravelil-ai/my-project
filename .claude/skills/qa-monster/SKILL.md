---
name: qa-monster
description: Run, extend and triage the QA Monster audit — automated QA + security testing (Playwright, axe-core, OWASP ZAP, TLS/header/exposure checks) for the sites in sites.json (mydubai-travel.com, thailand-express.com), with an event log (events.jsonl), graded email report and a dashboard. Use when asked to audit/scan/test a site, check site security or quality, explain or fix findings, compare runs (what's new / resolved), open or extend the dashboard, add a site, staging URL or user-flow test, tune severity/budgets, or work on the scheduled GitHub Actions run and email report.
---

# QA Monster — security & quality audit

Each run grades every site on **Security** and **QA** (A+…F), lists findings by severity with a concrete fix,
compares with the previous run (new / resolved), emails an HTML report and feeds a local dashboard.

## Ground rules (non-negotiable)

1. **Only audit sites the user owns or is explicitly authorized to test.** Sites live in `sites.json`.
   Before adding a domain, confirm the user owns it.
2. **Passive by default.** Playwright checks only read pages (GET/HEAD); forms are inspected, **never submitted**.
3. **OWASP ZAP on live sites = `baseline` (passive) only.** `full` (active: attack payloads, junk data, WAF trips)
   runs only against a site's `stagingUrl` or a local address. `scripts/lib/zap-policy.mjs` enforces this in CI and
   locally; never bypass it, and never point a `stagingUrl` at the production host.
4. **SMTP details live only in GitHub Secrets** (`SMTP_SERVER`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`,
   `REPORT_EMAIL`, optional `SMTP_FROM`). Never write credentials, hosts or recipients into code or config files.
5. Never write exploit code, brute-force logins, or exfiltrate data. Findings describe the weakness and the fix.
6. Found a secret exposed (`.env`, `.git`, dumps)? Tell the user to **rotate it immediately**. Blocking access is not enough.

## Architecture: one source of truth

```
checks (Playwright specs, ZAP ingest) ─► lib/logger.cjs ─► runs/<runId>/events.jsonl
                                                               │
                                     lib/model.mjs (pure: grades, coverage, diff)
                                       ├─► lib/render-email.mjs → report.html / summary.md (email, issue)
                                       └─► dashboard/app.mjs (browser)
```

- **Every check reports through the logger** — never write findings anywhere else. In specs use the fixtures:
  `findings.high(title, { url, detail, fix, key })` and `log.metric(name, value, { unit, url, budget })`,
  `log.saveArtifact(kind, relPath, buffer, { label, url })`, `log.info(...)`.
- Lifecycle events (`run.start`, `check.start` / `check.end`, `run.phase`) come from `lib/global-setup.ts`,
  the auto `findings` fixture and `lib/global-teardown.ts`, so they are recorded whatever `--reporter` is used.
- `scripts/build-report.mjs` **finalizes** a run: appends `run.end` with the verdict and the comparison with its
  baseline, then renders from what was recorded. A finalized run is self-describing: the dashboard reuses the stored
  comparison, so it always matches the email.
- Never compute grades, counts or "new/resolved" anywhere except `lib/model.mjs`. Change the rule there and both
  outputs change together. Event schema: `references/events.md`.

## Layout

| Path | Purpose |
|---|---|
| `sites.json` | Sites, optional `stagingUrl`, critical paths, crawl limits, performance budgets |
| `lib/logger.cjs` (+ `.d.cts`) | Event logger, run ids, stable finding fingerprints |
| `lib/model.mjs` | Pure model: parse events, checks/coverage, scores & grades, diff, baseline choice |
| `lib/render-email.mjs` | Email HTML + Markdown from the model |
| `lib/fixtures.ts`, `lib/findings.ts` | `site`, `log`, `findings` fixtures; a check fails when it records findings ≥ `FAIL_ON` |
| `tests/qa/*`, `tests/security/*` | Checks (availability, links, seo, accessibility, performance, responsive, forms; transport, headers, exposure) |
| `tests/flows/<site>/*` | Site-specific user journeys (run only for that site) |
| `tests/unit/*.test.mjs` | `node:test` unit tests for model, logger, ZAP policy/ingest, GitHub sync, rendering |
| `scripts/audit.mjs` | `npm run audit`: Playwright run + finalize + report (cross-platform) |
| `scripts/build-report.mjs` | Finalize a run and build `report.html`, `summary.md`, `summary.json` |
| `scripts/dashboard.mjs`, `dashboard/` | Local dashboard server (127.0.0.1) and UI |
| `scripts/sync-github.mjs`, `scripts/lib/github.mjs` | Download `qa-monster-events` artifacts into `runs/` |
| `scripts/zap.mjs`, `scripts/ingest-zap.mjs`, `scripts/zap-targets.mjs` | Local ZAP (Docker), ZAP → events, CI matrix/guard |
| `scripts/merge-events.mjs` | Merge event shards from parallel CI jobs |
| `.github/workflows/qa-monster.yml` | Daily + manual run: setup → playwright ∥ zap → report (email, Slack, issue) |

## Running

```bash
npm ci && npx playwright install chromium   # once
npm run audit                                # all sites: run, finalize, report
SITE=mydubai-travel npm run audit            # one site
npm run audit:security                       # security checks only (QA grade shows "—")
npm run audit -- --fail                      # exit 1 on blocking findings
FAIL_ON=medium npm run audit                 # stricter gate
npm run dashboard                            # http://127.0.0.1:4173
npm run sync                                 # pull recent GitHub Actions runs into runs/
npm run zap -- --site thailand-express       # passive ZAP of the live site (Docker)
npm run zap -- --site mydubai-travel --full  # ACTIVE ZAP of its stagingUrl only
npm run test:unit && npm run typecheck       # before committing
```

In a Claude Code cloud session the network policy may block the sites (proxy 403). Ask the user to allow the domains
(environment settings → Network access) or trigger the workflow and read its `qa-monster-events` artifact
(`npm run sync`, or `GITHUB_TOKEN=... npm run sync`). For a Chromium that differs from Playwright's, set `CHROMIUM_PATH`.

## Comparing runs (new / resolved)

- Baseline = the latest earlier **finalized** run from the **same source** (local vs GitHub) — `pickBaseline`.
- **New**: present now, absent in the baseline, and its check *completed* in the baseline.
- **Resolved**: present in the baseline, absent now, and its check *completed* now. A check that did not run
  (site filter, ZAP skipped, crash) never resolves anything.
- Identity is the finding fingerprint (site + category + check + normalized title/url/first detail line, numbers
  ignored). When a title or detail is volatile (lists, referrers, sizes), pass a stable `key`.

## Triage workflow ("what's wrong / what should I fix")

1. Read the run: `runs/<run>/summary.json` / `report.html`, or build the model from `events.jsonl`. Lead with grades
   and critical/high counts, then what is **new** since the previous run.
2. Order: **critical → high → new → medium**. Group by root cause (all missing headers = one server-config change).
3. For each item: plain-language meaning, real-world risk for a travel booking site (lead/payment data, reputation,
   SEO, conversions), and the exact fix — `references/fix-recipes.md`.
4. "Check could not complete" findings are infrastructure or test problems: open the Playwright report/trace before
   treating them as site issues.
5. Be honest about false positives (third-party 403s, CDN-set headers) and tune (`.zap/rules.tsv`, budgets in
   `sites.json`) instead of hiding real issues.
6. Severity meanings and the scoring model: `references/severity.md`.

## Extending

- **New site:** append to `sites.json` → `{ "name": "...", "baseUrl": "https://...", "stagingUrl": null, "criticalPaths": ["/"] }`
  and add `tests/flows/<name>/`. Confirm ownership first.
- **New user flow:** copy `tests/flows/mydubai-travel/home.spec.ts`. Never submit real bookings/leads on production.
- **New check:** add a spec under `tests/qa` or `tests/security`, `import { test } from '../../lib/fixtures'`, record via
  `findings.<severity>(title, { url, detail, fix, key })` (always a `fix`) and numbers via `log.metric`. Category = file
  name: add a Hebrew label to `CATEGORY_LABELS` / `CATEGORY_ORDER` in `lib/model.mjs` (and `SECURITY_CATEGORIES` if it
  is a security check).
- Validate with `npm run test:unit`, `npm run typecheck`, and a run against a local server
  (`SITES_FILE=<test sites.json> npm run audit`), then look at the dashboard.
