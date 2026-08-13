export type ConflictWinner = "local" | "remote";

/**
 * Decide which version of a row survives when two writes collide.
 *
 * Last-write-wins by HLC (PROJECT_PLAN §5.4). Because an HLC encodes millis,
 * then counter, then node id — each fixed-width — a plain lexicographic compare
 * is the whole rule, and the trailing node id guarantees that two terminals
 * examining the same pair reach the *same* verdict. Without that tiebreak the
 * two tills would each keep their own row and never converge.
 *
 * Losing versions are never dropped silently; callers record them in the audit log.
 */
export function resolveConflict(localHlc: string | null, remoteHlc: string): ConflictWinner {
  if (localHlc === null) return "remote";
  return remoteHlc > localHlc ? "remote" : "local";
}
