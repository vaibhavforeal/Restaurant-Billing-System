/** One replicated mutation, as it travels between terminal and cloud. */
export interface ChangeRecord {
  /** Outbox entry id — stable, so a redelivered change is recognisable. */
  id: string;
  org_id: string;
  entity: string;
  entity_id: string;
  op: "upsert" | "delete";
  payload: Record<string, unknown>;
  hlc: string;
}

export interface PullRequest {
  entities: string[];
  /** HLC cursor; null means "everything from the beginning". */
  since: string | null;
}

export interface PullResult {
  changes: ChangeRecord[];
  /** Highest HLC included — persist as the next cursor. */
  cursor: string | null;
}

/**
 * The seam between our sync logic and however the bytes actually move.
 *
 * Phase 0 ships a direct in-process implementation for tests and the demo. The
 * engine decision (custom outbox+CDC vs. PowerSync vs. ElectricSQL, per
 * PROJECT_PLAN §12) only has to satisfy this interface, so it can be deferred
 * without holding up the schema or the terminal.
 */
export interface SyncTransport {
  push(changes: ChangeRecord[]): Promise<void>;
  pull(request: PullRequest): Promise<PullResult>;
}
