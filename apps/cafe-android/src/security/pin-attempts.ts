const TRIES = 5;
const FIRST_LOCK_MS = 30_000;

/**
 * Counts wrong owner PINs across every prompt in the app. After five wrong tries, attempts are locked for 30 seconds,
 * then 60, then 120... until the right PIN is entered. Kept in memory: restarting the app clears it.
 */
export function createPinAttempts() {
  let wrong = 0;
  let locks = 0;
  let lockedUntil = 0;
  return {
    /** How long until another try is allowed; 0 when it is allowed now. */
    waitMs(now: number): number { return Math.max(0, lockedUntil - now); },
    fail(now: number): { locked: boolean; triesLeft: number } {
      wrong++;
      if (wrong < TRIES) return { locked: false, triesLeft: TRIES - wrong };
      lockedUntil = now + FIRST_LOCK_MS * 2 ** locks;
      locks++;
      wrong = 0;
      return { locked: true, triesLeft: 0 };
    },
    succeed() { wrong = 0; locks = 0; lockedUntil = 0; },
  };
}

/** The app's one counter for the owner PIN. */
export const ownerPinAttempts = createPinAttempts();
