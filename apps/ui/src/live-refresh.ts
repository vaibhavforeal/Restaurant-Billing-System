import { useEffect } from "react";
import { session } from "./api";
import { connectWs } from "./ws";

export interface LiveRefreshOptions {
  /** Live events that schedule a refresh. */
  events?: readonly string[];
  /** Quiet time before an event refresh runs, so a burst of events refreshes once. */
  debounceMs?: number;
  /** Refresh on this interval even when no event arrives. */
  pollMs?: number;
}

/**
 * Calls `refresh` after a debounced live event, after the socket reconnects (not on the first connect), and every
 * `pollMs`. An auth failure clears the session. The socket, timer and interval are cleaned up on unmount.
 */
export function useLiveRefresh(
  refresh: () => void,
  { events = ["order.updated"], debounceMs = 400, pollMs = 60000 }: LiveRefreshOptions = {},
): void {
  // Key on the joined names so an inline array literal does not restart the socket on every render.
  const eventKey = events.join(",");

  useEffect(() => {
    const watched = new Set(eventKey.split(","));
    let scheduled: ReturnType<typeof setTimeout> | undefined;
    let connectedOnce = false;
    const schedule = () => { clearTimeout(scheduled); scheduled = setTimeout(refresh, debounceMs); };
    const stop = connectWs({
      onEvent: (event) => { if (watched.has(event)) schedule(); },
      onStatus: (connected) => { if (connected) { if (connectedOnce) schedule(); connectedOnce = true; } },
      onAuthFail: () => session.clear(),
    });
    const timer = setInterval(refresh, pollMs);
    return () => { stop(); clearTimeout(scheduled); clearInterval(timer); };
  }, [refresh, eventKey, debounceMs, pollMs]);
}
