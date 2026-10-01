# Severity model

| Severity | Meaning | Examples | Expected response |
|---|---|---|---|
| critical | Active, direct compromise or site down | `.env`/`.git` exposed, expired/untrusted TLS, form posting over HTTP, DB error leaking, page down | Same day. Rotate exposed secrets. |
| high | Serious weakness or major breakage | No HTTP→HTTPS redirect, mixed content, session cookie without HttpOnly, broken internal links, noindex on prod, debug output, phpMyAdmin public, axe "critical" a11y, ZAP High, a site or check group that did not run | Within days |
| medium | Real risk / quality loss with preconditions | Missing CSP / clickjacking protection / HSTS, no compression, mobile horizontal scroll, JS exceptions, ZAP Medium, a check that could not complete | Next sprint |
| low | Hardening, best practice | Referrer-Policy, version disclosure, SEO polish, small perf budgets, ZAP Low | Backlog |
| info | Context, inventory | Certificate details, third-party domains, login pages found | None |

`FAIL_ON` (default `high`) sets which severities count as blocking: they fail the run, open the tracking issue and
mark the email subject ⚠️.

## Scores

Each site gets two scores. Security = `transport`, `headers`, `exposure`, `zap`; QA = everything else.
Start at 100 and subtract per finding: critical 30, high 12, medium 4, low 1. Each (category, severity) pair counts at
most 3 times (6 for low), so one noisy check can't zero the score.
Grades: A+ ≥ 95 · A ≥ 85 · B ≥ 75 · C ≥ 60 · D ≥ 45 · F below.
A group with no completed check in the run gets **"—"** (not checked) instead of a misleading A+.

## ZAP risk mapping

ZAP High → high, Medium → medium, Low → low, Informational → info. Alerts about third-party hosts (CDNs, analytics)
are not counted against the site.
