# Event schema (events.jsonl, schema v1)

One JSON object per line, appended by `lib/logger.cjs`. Order in the file does not matter: readers sort by
`ts`, then `pid`, then `seq`. Common fields on every event:

| Field | Meaning |
|---|---|
| `v` | schema version (1) |
| `ts` | ISO timestamp |
| `runId` | run identifier (`local-YYYYMMDD-HHMMSS-xxxx` or `gh-<workflow run id>-<attempt>`) |
| `pid`, `seq` | writer process and per-process sequence (ordering + de-duplication) |
| `type` | one of the types below |
| `site`, `category`, `check` | context, on everything a check emits (`category` = spec file name, `flows`, `zap`) |

| Type | Emitted by | Extra fields |
|---|---|---|
| `run.start` | global setup, `scripts/zap.mjs`, or reconstructed by `merge-events.mjs` | `source` (`local`/`github`), `sites` [{name, baseUrl}], `failOn`, `expect` (check groups that must run: `qa`, `security`), `git`, `github` {runId, attempt, url, event}, `tool` |
| `check.start` | `findings` fixture / ZAP ingest | `retry`, `mode`, `target` |
| `check.end` | `findings` fixture / ZAP ingest | `status` (`passed`, `failed`, `timedOut`, `skipped`, `interrupted`), `completed` (the check finished its job; blocking findings still count as completed), `blocking`, `durationMs`, `error` |
| `finding` | `findings.<severity>()` / ZAP ingest | `fp` (stable fingerprint), `severity`, `title`, `url`, `detail`, `fix`, `source` (`playwright`/`zap`) |
| `metric` | `log.metric()` | `name`, `value`, `unit`, `url`, `budget` |
| `artifact` | `log.saveArtifact()`, `scripts/zap.mjs` | `kind` (`screenshot`, `zap-report`), `path` (relative to the run directory), `label`, `url`, `bytes` |
| `log` | `log.info/warn/error()` | `level`, `message` |
| `run.phase` | global teardown, `scripts/zap.mjs` | `phase` (`playwright`, `zap`) |
| `run.end` | `scripts/build-report.mjs` (finalize; the last one wins) | `status` (`pass`/`fail`), `failOn`, `blocking`, `diff` {baselineRunId, baselineStartedAt, baselineSites, new: [fp], resolved: [{fp, site, category, check, severity, title, url}]} |

Derived by the model (never stored as events): synthetic findings for checks that could not complete
(`incomplete:<site|category|check>`, medium) and for sites or expected check groups that did not run
(`not-checked:<site>:<group>`, high).

Run status: `running` (no end marker yet), `unfinalized` (a phase ended, no `run.end`), `complete` (`run.end`
present), `stale` (no end marker and no event for 20 minutes).
