import type { Database } from "@masalapos/domain";
import { httpError } from "./http-error.js";

/**
 * The earlier request saved under this client reference, when this is a retry of it (the reply was lost, so the screen sent the
 * same request again): the caller answers as before without repeating the change. Null when the reference is new. The same
 * reference sent with a different request is refused with 409 and `conflict`. `table` is a fixed table name with `client_ref` and
 * `request_json` columns; `columns` adds others the caller needs to answer the retry.
 */
export function priorRequest<T extends object = object>(db: Database, table: string, clientRef: string, requestJson: string, conflict: string,
  columns = ""): T | null {
  const row = db.prepare(`SELECT request_json${columns ? `, ${columns}` : ""} FROM ${table} WHERE client_ref = ?`).get(clientRef) as
    (T & { request_json: string }) | undefined;
  if (!row) return null;
  if (row.request_json !== requestJson) throw httpError(409, conflict);
  return row;
}
