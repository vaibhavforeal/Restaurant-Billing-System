import type { FastifyBaseLogger } from "fastify";

/**
 * Wraps only the *rendering* of a slip (profile parsing, ESC/POS bytes). A bad printer profile is a
 * configuration fault that must not roll back a sale or kitchen ticket, so it is logged and reported to the
 * caller. Persisting the job is not wrapped: a failed queue insert still aborts the surrounding transaction,
 * so a bill or KOT is never committed without its print job.
 */
export function bestEffortPrint<T>(log: FastifyBaseLogger, what: string, run: () => T): { value: T | null; error: string | null } {
  try {
    return { value: run(), error: null };
  } catch (err) {
    log.error({ err }, `Could not queue print for ${what}`);
    return { value: null, error: `${what} was saved but could not be queued for printing` };
  }
}
