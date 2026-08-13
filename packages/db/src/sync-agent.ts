import { resolveConflict, type ChangeRecord, type SyncTransport } from "@forkflow/sync";
import type { DbHandle, Row } from "./client.js";
import { reviveRow, tableByName } from "./serialize.js";
import { SYNCED_TABLES, outbox, sync_state } from "./schema.js";

const PUSH_BATCH = 500;
const CURSOR_KEY = "pull_cursor";

export interface SyncAgentOptions {
  db: DbHandle;
  transport: SyncTransport;
  orgId: string;
  /** Entities to pull down. Defaults to every synced table. */
  entities?: string[];
}

export interface PushResult {
  pushed: number;
}

export interface PullResultSummary {
  applied: number;
  /** Remote changes rejected because the local row was newer. */
  rejected: number;
}

export interface SyncAgent {
  /** Drain the outbox to the cloud. Safe to call repeatedly. */
  push(): Promise<PushResult>;
  /** Apply cloud changes locally — menu, prices, taxes, other terminals' work. */
  pull(): Promise<PullResultSummary>;
}

function toChangeRecord(entry: Row): ChangeRecord {
  return {
    id: entry.id as string,
    org_id: entry.org_id as string,
    entity: entry.entity as string,
    entity_id: entry.entity_id as string,
    op: entry.op as "upsert" | "delete",
    payload: entry.payload as Record<string, unknown>,
    hlc: entry.hlc as string,
  };
}

/**
 * The terminal's half of replication (PROJECT_PLAN §5.3).
 *
 * Push and pull are deliberately separate and individually retryable: a till
 * mid-service cares far more about getting its bills *out* than about being
 * current, and a failed pull must never block a push.
 */
export function createSyncAgent(options: SyncAgentOptions): SyncAgent {
  const { db, transport } = options;
  const entities = options.entities ?? SYNCED_TABLES.map((table) => table.name);

  return {
    async push() {
      const pending = await db.selectUnsynced(outbox, PUSH_BATCH);
      if (pending.length === 0) return { pushed: 0 };

      await transport.push(pending.map(toChangeRecord));

      // Marked only after the transport resolves. A crash here re-sends on the
      // next drain, which is why applying a change is idempotent by row id.
      const at = new Date();
      for (const entry of pending) {
        await db.upsert(outbox, { ...entry, synced_at: at });
      }

      return { pushed: pending.length };
    },

    async pull() {
      const cursorRow = await db.findById(sync_state, CURSOR_KEY);
      const since = (cursorRow?.value as string | undefined) ?? null;

      const { changes, cursor } = await transport.pull({ entities, since });
      let applied = 0;
      let rejected = 0;

      for (const change of changes) {
        const table = tableByName(change.entity);
        const existing = await db.findById(table, change.entity_id);
        const localHlc = (existing?.hlc as string | undefined) ?? null;

        if (resolveConflict(localHlc, change.hlc) === "local") {
          rejected += 1;
          continue;
        }

        await db.upsert(table, { ...reviveRow(table, change.payload), synced_at: new Date() });
        applied += 1;
      }

      if (cursor !== null && cursor !== since) {
        await db.upsert(sync_state, { key: CURSOR_KEY, value: cursor, updated_at: new Date() });
      }

      return { applied, rejected };
    },
  };
}
