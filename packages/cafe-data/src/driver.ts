/**
 * The phone's database, seen through four synchronous calls. The app supplies an expo-sqlite adapter and the tests a
 * better-sqlite3 one, so every repository reads the same in both.
 */
export interface SqlDriver {
  run(sql: string, params?: readonly unknown[]): void;
  get<T>(sql: string, params?: readonly unknown[]): T | undefined;
  all<T>(sql: string, params?: readonly unknown[]): T[];
  /** Not re-entrant: a transaction inside a transaction throws. */
  transaction<T>(fn: () => T): T;
}
