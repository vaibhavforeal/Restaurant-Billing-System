import { resolveConflict, type ChangeRecord, type SyncTransport } from "@forkflow/sync";
import type { DbHandle } from "./client.js";
import { reviveRow, tableByName } from "./serialize.js";

const PULL_LIMIT = 500;

/**
 * A `SyncTransport` that writes straight into a cloud handle, in-process.
 *
 * Stands in for the network so the whole offline→online path can be tested and
 * demoed for real. When the sync engine is chosen (PROJECT_PLAN §12) it slots in
 * behind this same interface; the conflict rule below moves to the server and
 * nothing else changes.
 */
export function createDirectTransport(cloud: DbHandle): SyncTransport {
  return {
    async push(changes: ChangeRecord[]) {
      for (const change of changes) {
        const table = tableByName(change.entity);
        const existing = await cloud.findById(table, change.entity_id);
        const localHlc = (existing?.hlc as string | undefined) ?? null;

        // A terminal that was offline for a day can arrive with a stale edit;
        // the cloud must not let it clobber a newer one.
        if (resolveConflict(localHlc, change.hlc) === "local") continue;

        await cloud.upsert(table, { ...reviveRow(table, change.payload), synced_at: new Date() });
      }
    },

    async pull({ entities, since }) {
      const changes: ChangeRecord[] = [];

      for (const entity of entities) {
        const table = tableByName(entity);
        for (const row of await cloud.selectSince(table, since, PULL_LIMIT)) {
          changes.push({
            id: row.id as string,
            org_id: row.org_id as string,
            entity,
            entity_id: row.id as string,
            op: row.deleted_at ? "delete" : "upsert",
            payload: row,
            hlc: row.hlc as string,
          });
        }
      }

      changes.sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
      return { changes, cursor: changes.at(-1)?.hlc ?? since };
    },
  };
}
