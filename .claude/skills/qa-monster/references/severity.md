# Severity model

| Severity | Meaning | Examples | Expected response |
|---|---|---|---|
| critical | Active, direct compromise or site down | `.env`/`.git` exposed, expired/untrusted TLS, form posting over HTTP, DB error leaking, page down | Same day. Rotate exposed secrets. |
| high | Serious weakness or major breakage | No HTTP→HTTPS redirect, mixed content, session cookie without HttpOnly, broken internal links, noindex on prod, debug output, phpMyAdmin public, axe "critical" a11y | Within days |
| medium | Real risk / quality loss with preconditions | Missing CSP / clickjacking protection / HSTS, no compression, mobile horizontal scroll, JS exceptions, ZAP medium | Next sprint |
| low | Hardening, best practice | Referrer-Policy, version disclosure, SEO polish, small perf budgets | Backlog |
| info | Context, inventory | Metrics, third-party domains, login pages found | None |

`FAIL_ON` (default `high`) sets which severities fail the run and open the tracking issue.

## Scores

Each site gets two scores (Security = transport, headers, exposure, ZAP; QA = everything else).
Start at 100, subtract per finding: critical 30, high 12, medium 4, low 1 — capped per (category, severity)
at 3 occurrences (6 for low) so one noisy check can't zero the score.
Grades: A+ ≥ 95 · A ≥ 85 · B ≥ 75 · C ≥ 60 · D ≥ 45 · F below. A site with no results shows "—" and a high finding.

## ZAP risk mapping

ZAP High → high, Medium → medium, Low → low, Informational → info.
