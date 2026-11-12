import type { SqlDriver } from "@masalapos/cafe-data";

/** The part of expo-sqlite's SQLiteDatabase the adapter uses; a test supplies the same shape over better-sqlite3. */
export interface SyncSqlite {
  runSync(sql: string, params: unknown[]): unknown;
  getFirstSync<T>(sql: string, params: unknown[]): T | null;
  getAllSync<T>(sql: string, params: unknown[]): T[];
  withTransactionSync(task: () => void): void;
}

/** cafe-data's SqlDriver over expo-sqlite's synchronous calls. A transaction inside a transaction throws. */
export function expoDriver(db: SyncSqlite): SqlDriver {
  let inTransaction = false;
  const args = (params?: readonly unknown[]) => [...(params ?? [])];
  return {
    run(sql, params) { db.runSync(sql, args(params)); },
    get<T>(sql: string, params?: readonly unknown[]) { return db.getFirstSync<T>(sql, args(params)) ?? undefined; },
    all<T>(sql: string, params?: readonly unknown[]) { return db.getAllSync<T>(sql, args(params)); },
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error("nested transaction");
      inTransaction = true;
      try {
        let value: T | undefined;
        db.withTransactionSync(() => { value = fn(); });
        return value as T;
      } finally {
        inTransaction = false;
      }
    },
  };
}
