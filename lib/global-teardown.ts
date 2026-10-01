import { ensureRunId, Logger } from './logger.cjs';

/** Marks the end of the Playwright phase; build-report.mjs later finalizes the run with run.end. */
export default async function globalTeardown() {
  new Logger({ runId: ensureRunId() }).emit('run.phase', { phase: 'playwright' });
}
