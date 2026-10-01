import type { Logger, Severity } from './logger.cjs';

export type { Severity };
export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 };

export interface FindingOptions {
  detail?: string;
  url?: string;
  fix?: string;
  /** Stable identity when the title or the first line of detail is volatile (see Logger.findingFingerprint). */
  key?: string;
}

export interface Finding extends FindingOptions {
  fp: string;
  severity: Severity;
  title: string;
}

export function failThreshold(): Severity {
  const v = (process.env.FAIL_ON ?? 'high') as Severity;
  return v in SEVERITY_RANK ? v : 'high';
}

/** Findings of one check. Each one is sent through the event logger as soon as it is recorded. */
export class Findings {
  readonly items: Finding[] = [];
  private seen = new Set<string>();

  constructor(private log: Logger) {}

  add(severity: Severity, title: string, opts: FindingOptions = {}) {
    const fp = this.log.findingFingerprint({ title, ...opts });
    if (this.seen.has(fp)) return;
    this.seen.add(fp);
    this.items.push({ fp, severity, title, ...opts });
    this.log.finding({ severity, title, ...opts, fp });
  }

  critical(title: string, opts?: FindingOptions) { this.add('critical', title, opts); }
  high(title: string, opts?: FindingOptions) { this.add('high', title, opts); }
  medium(title: string, opts?: FindingOptions) { this.add('medium', title, opts); }
  low(title: string, opts?: FindingOptions) { this.add('low', title, opts); }
  info(title: string, opts?: FindingOptions) { this.add('info', title, opts); }

  blocking(): Finding[] {
    const min = SEVERITY_RANK[failThreshold()];
    return this.items.filter((f) => SEVERITY_RANK[f.severity] >= min);
  }
}
