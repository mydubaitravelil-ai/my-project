export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface LoggerContext {
  site?: string;
  category?: string;
  check?: string;
  [key: string]: unknown;
}

export interface FindingInput {
  severity: Severity;
  title: string;
  url?: string;
  detail?: string;
  fix?: string;
  /** Stable identity when the title/detail contains volatile parts. */
  key?: string;
  source?: string;
  fp?: string;
}

export interface QaEvent {
  v: number;
  ts: string;
  runId: string;
  pid: number;
  seq: number;
  type: string;
  [key: string]: unknown;
}

export declare const SCHEMA_VERSION: number;
export declare const SEVERITIES: Severity[];

export declare class Logger {
  constructor(opts?: { runId?: string; file?: string; context?: LoggerContext });
  readonly runId: string;
  readonly file: string;
  readonly context: LoggerContext;
  child(context: LoggerContext): Logger;
  runDir(): string;
  emit(type: string, data?: Record<string, unknown>): QaEvent;
  findingFingerprint(f: Pick<FindingInput, 'title' | 'url' | 'detail' | 'key'>): string;
  finding(f: FindingInput): QaEvent;
  metric(name: string, value: number, opts?: { unit?: string; url?: string; budget?: number }): QaEvent | null;
  saveArtifact(kind: string, relPath: string, body: Buffer, opts?: { label?: string; url?: string }): QaEvent;
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>): QaEvent;
  info(message: string, data?: Record<string, unknown>): QaEvent;
  warn(message: string, data?: Record<string, unknown>): QaEvent;
  error(message: string, data?: Record<string, unknown>): QaEvent;
}

export declare function categoryOf(file: string): string;
export declare function ensureRunId(): string;
export declare function eventsFile(runId: string): string;
export declare function fingerprint(...parts: unknown[]): string;
export declare function getLogger(): Logger;
export declare function newRunId(source?: string): string;
export declare function normalizeKey(s: unknown): string;
export declare function runSource(): string;
export declare function runsDir(): string;
