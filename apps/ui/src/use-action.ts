import { useMemo, useState } from "react";

/**
 * Runs one action at a time: a second call while one is running does nothing (a plain flag, so a double click is caught before React
 * re-renders a disabled button), `busy` is on while it runs, and a thrown error becomes `error` in plain words (`fallback` when it
 * carries no message). Resolves to whether the action succeeded, so a caller can reload on failure.
 */
export function actionRunner(setBusy: (busy: boolean) => void, setError: (error: string) => void) {
  let running = false;
  return async (action: () => Promise<unknown>, fallback = "Request failed"): Promise<boolean> => {
    if (running) return false;
    running = true; setBusy(true); setError("");
    try { await action(); return true; }
    catch (e) { setError(e instanceof Error && e.message ? e.message : fallback); return false; }
    finally { running = false; setBusy(false); }
  };
}

/** A screen's actions, one at a time, with `busy` for its buttons and `error` for its alert; see actionRunner. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = useMemo(() => actionRunner(setBusy, setError), []);
  return { busy, error, setError, run };
}
