import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export interface Finding {
  site: string;
  category: string;
  check: string;
  severity: Severity;
  title: string;
  detail?: string;
  url?: string;
  fix?: string;
}

export const FINDINGS_DIR = path.join(__dirname, '..', 'reports', 'findings');

export function failThreshold(): Severity {
  const v = (process.env.FAIL_ON ?? 'high') as Severity;
  return v in SEVERITY_RANK ? v : 'high';
}

/** Collects findings for one test; flushed to reports/findings/*.json by the fixture. */
export class Findings {
  readonly items: Finding[] = [];
  private seen = new Set<string>();

  constructor(private site: string, private category: string, private check: string) {}

  add(severity: Severity, title: string, opts: { detail?: string; url?: string; fix?: string } = {}) {
    const key = `${severity}|${title}|${opts.url ?? ''}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.items.push({ site: this.site, category: this.category, check: this.check, severity, title, ...opts });
  }

  critical(title: string, opts?: Parameters<Findings['add']>[2]) { this.add('critical', title, opts); }
  high(title: string, opts?: Parameters<Findings['add']>[2]) { this.add('high', title, opts); }
  medium(title: string, opts?: Parameters<Findings['add']>[2]) { this.add('medium', title, opts); }
  low(title: string, opts?: Parameters<Findings['add']>[2]) { this.add('low', title, opts); }
  info(title: string, opts?: Parameters<Findings['add']>[2]) { this.add('info', title, opts); }

  blocking(): Finding[] {
    const min = SEVERITY_RANK[failThreshold()];
    return this.items.filter((f) => SEVERITY_RANK[f.severity] >= min);
  }

  write() {
    fs.mkdirSync(FINDINGS_DIR, { recursive: true });
    const id = crypto.createHash('sha1').update(`${this.site}|${this.category}|${this.check}`).digest('hex').slice(0, 12);
    fs.writeFileSync(
      path.join(FINDINGS_DIR, `${this.site}-${this.category}-${id}.json`),
      JSON.stringify({ site: this.site, category: this.category, check: this.check, findings: this.items }, null, 2),
    );
  }
}
