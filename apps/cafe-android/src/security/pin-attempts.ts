import { getLocalState, setLocalState, type SqlDriver } from "@masalapos/cafe-data";

const TRIES = 5;
const FIRST_LOCK_MS = 30_000;

export interface PinAttemptState { wrong: number; locks: number; lockedAt: number; lockedUntil: number }
export interface PinAttemptStore { load(): PinAttemptState; save(state: PinAttemptState): void }

const EMPTY: PinAttemptState = { wrong: 0, locks: 0, lockedAt: 0, lockedUntil: 0 };

export function memoryPinStore(): PinAttemptStore {
  let state = EMPTY;
  return { load: () => state, save: (s) => { state = s; } };
}

/** Keeps one person's count in the phone's database (`pin:<staffId>:*`), so restarting the app does not clear a lock. */
export function databasePinStore(db: SqlDriver, staffId: string): PinAttemptStore {
  const KEYS = { wrong: `pin:${staffId}:wrong`, locks: `pin:${staffId}:locks`, lockedAt: `pin:${staffId}:lockedAt`,
    lockedUntil: `pin:${staffId}:lockedUntil` };
  return {
    load: () => ({
      wrong: getLocalState(db, KEYS.wrong) ?? 0, locks: getLocalState(db, KEYS.locks) ?? 0,
      lockedAt: getLocalState(db, KEYS.lockedAt) ?? 0, lockedUntil: getLocalState(db, KEYS.lockedUntil) ?? 0,
    }),
    save: (s) => setLocalState(db, { [KEYS.wrong]: s.wrong, [KEYS.locks]: s.locks, [KEYS.lockedAt]: s.lockedAt, [KEYS.lockedUntil]: s.lockedUntil }),
  };
}

/**
 * Counts wrong PINs. After five wrong tries, entry is locked for 30 seconds, then 60, then 120... until the right
 * PIN is entered. A clock moved back to before the lock began keeps the whole lock in force.
 */
export function createPinAttempts(store: PinAttemptStore = memoryPinStore()) {
  return {
    /** How long until another try is allowed; 0 when it is allowed now. */
    waitMs(now: number): number {
      const s = store.load();
      if (s.lockedUntil <= 0) return 0;
      if (now < s.lockedAt) return s.lockedUntil - s.lockedAt;
      return Math.max(0, s.lockedUntil - now);
    },
    fail(now: number): { locked: boolean; triesLeft: number } {
      const s = store.load();
      const wrong = s.wrong + 1;
      if (wrong < TRIES) {
        store.save({ ...s, wrong });
        return { locked: false, triesLeft: TRIES - wrong };
      }
      store.save({ wrong: 0, locks: s.locks + 1, lockedAt: now, lockedUntil: now + FIRST_LOCK_MS * 2 ** s.locks });
      return { locked: true, triesLeft: 0 };
    },
    succeed() { store.save(EMPTY); },
  };
}

/** One staff member's wrong-PIN counter, kept in this phone's database. Each person locks on their own. */
export const staffPinAttempts = (db: SqlDriver, staffId: string) => createPinAttempts(databasePinStore(db, staffId));
