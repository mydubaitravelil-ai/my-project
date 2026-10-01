#!/usr/bin/env node
// CI helper for the ZAP policy (scripts/lib/zap-policy.mjs).
//   node scripts/zap-targets.mjs --mode baseline|full [--site a,b]   → prints the scan matrix as JSON
//   node scripts/zap-targets.mjs --assert --mode full --url <url>     → exits 1 if the scan is not allowed
import { assertZapAllowed, loadSitesConfig, zapTargets } from './lib/zap-policy.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const sites = loadSitesConfig();
const mode = opt('--mode') ?? 'baseline';

try {
  if (args.includes('--assert')) {
    // In CI there is no "local" target: only production (passive) or staging.
    assertZapAllowed({ mode, url: opt('--url'), sites, allowLocal: false });
    console.log(`OK: ${mode} scan of ${opt('--url')} is allowed`);
  } else {
    process.stdout.write(JSON.stringify(mode === 'none' ? [] : zapTargets({ mode, sites, only: opt('--site') || undefined })));
  }
} catch (e) {
  console.error(`::error::${e.message}`);
  process.exit(1);
}
