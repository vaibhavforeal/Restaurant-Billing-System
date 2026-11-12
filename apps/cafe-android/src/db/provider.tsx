import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { ScrollView, StyleSheet, Text } from "react-native";
import { openDatabaseSync, type SQLiteBindParams } from "expo-sqlite";
import { migrate, onDataChanged, type SqlDriver } from "@masalapos/cafe-data";
import { expoDriver } from "./expo-driver";
import { startErrorCapture } from "../errors/capture";
import { color, space, type } from "../theme/tokens";

const DbContext = createContext<SqlDriver | null>(null);

type Opened = { db: SqlDriver; error: null } | { db: null; error: string };

function open(): Opened {
  try {
    const raw = openDatabaseSync("cafe.db");
    raw.execSync("PRAGMA foreign_keys = ON");
    raw.execSync("PRAGMA journal_mode = WAL");
    // cafe-data binds only strings, numbers and null; expo-sqlite types its parameters more narrowly.
    const db = expoDriver({
      runSync: (sql, params) => raw.runSync(sql, params as SQLiteBindParams),
      getFirstSync: (sql, params) => raw.getFirstSync(sql, params as SQLiteBindParams),
      getAllSync: (sql, params) => raw.getAllSync(sql, params as SQLiteBindParams),
      withTransactionSync: (task) => raw.withTransactionSync(task),
    });
    migrate(db);
    startErrorCapture(db);
    return { db, error: null };
  } catch (e) {
    return { db: null, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Opens and migrates the cafe's database once. A failed migration stops the till with its message. */
export function DbProvider({ children }: { children: ReactNode }) {
  const [opened] = useState(open);
  if (opened.error !== null) {
    return (
      <ScrollView contentContainerStyle={styles.error}>
        <Text style={styles.title}>MasalaPOS Cafe could not open its data</Text>
        <Text style={styles.body}>{opened.error}</Text>
        <Text style={styles.body}>Your bills are safe on this phone. Update the app or contact MasalaPOS support.</Text>
      </ScrollView>
    );
  }
  return <DbContext.Provider value={opened.db}>{children}</DbContext.Provider>;
}

export function useDb(): SqlDriver {
  const db = useContext(DbContext);
  if (!db) throw new Error("useDb is used outside DbProvider");
  return db;
}

/** Reads from the database, and reads again whenever cafe-data reports a change. */
export function useData<T>(read: (db: SqlDriver) => T): T {
  const db = useDb();
  const [version, setVersion] = useState(0);
  useEffect(() => onDataChanged(() => setVersion((v) => v + 1)), []);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- version is the signal to read again
  return useMemo(() => read(db), [db, read, version]);
}

const styles = StyleSheet.create({
  error: { flexGrow: 1, justifyContent: "center", padding: space.lg, gap: space.md, backgroundColor: color.background },
  title: { ...type.headline, color: color.onSurface },
  body: { ...type.body, color: color.onSurfaceMuted },
});
