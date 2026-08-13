import { HybridLogicalClock, uuidv7 } from "@forkflow/sync";
import type { DbHandle, Row } from "./client.js";
import type { DualTable } from "./dialect.js";
import { outbox } from "./schema.js";

export interface RepositoryOptions {
  /** Stable terminal identity — becomes the HLC tiebreaker. */
  nodeId: string;
  orgId: string;
  now?: () => number;
  /**
   * Append every mutation to the outbox. True on a terminal, which must queue
   * its work for the cloud; false in the cloud, which owns no outbox — terminals
   * pull cloud changes by scanning row HLCs instead.
   */
  captureChanges?: boolean;
}

export interface Repository {
  readonly nodeId: string;
  /** Insert or update a row, recording the change for the cloud. Returns the row id. */
  write(table: DualTable, values: Row): Promise<string>;
  /** Soft-delete, so the removal itself replicates. */
  remove(table: DualTable, id: string): Promise<void>;
}

/**
 * Every local mutation goes through here.
 *
 * Writing the row and appending to the outbox is a single operation by
 * construction: a change that reached the table but not the outbox would be
 * invisible to the cloud forever, which is the one failure this design cannot
 * tolerate (PROJECT_PLAN §5.3).
 */
export function createRepository(db: DbHandle, options: RepositoryOptions): Repository {
  const clock = new HybridLogicalClock(
    options.now ? { nodeId: options.nodeId, now: options.now } : { nodeId: options.nodeId },
  );
  const nowAt = () => new Date(options.now?.() ?? Date.now());

  const captureChanges = options.captureChanges ?? true;

  async function record(table: DualTable, row: Row, op: "upsert" | "delete", hlc: string) {
    const at = nowAt();
    await db.upsert(table, row);
    if (!captureChanges) return;

    await db.insert(outbox, {
      id: uuidv7(),
      org_id: options.orgId,
      entity: table.name,
      entity_id: row.id as string,
      op,
      payload: row,
      hlc,
      created_at: at,
      synced_at: null,
    });
  }

  return {
    nodeId: options.nodeId,

    async write(table, values) {
      const id = (values.id as string | undefined) ?? uuidv7();
      const at = nowAt();
      const existing = values.id ? await db.findById(table, id) : null;
      const hlc = clock.tick();

      const row: Row = {
        deleted_at: null,
        ...values,
        id,
        org_id: options.orgId,
        created_at: (existing?.created_at as Date | undefined) ?? at,
        updated_at: at,
        hlc,
        synced_at: null,
      };

      await record(table, row, "upsert", hlc);
      return id;
    },

    async remove(table, id) {
      const existing = await db.findById(table, id);
      if (!existing) return;

      const at = nowAt();
      const hlc = clock.tick();
      const row: Row = { ...existing, updated_at: at, deleted_at: at, hlc, synced_at: null };

      await record(table, row, "delete", hlc);
    },
  };
}
