import type { FastifyRequest } from "fastify";
import { httpError } from "./http-error.js";

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

/**
 * A per-IP, per-action limit for the public guest pages (QR menu, service requests, feedback): at most `limit` calls a minute.
 * A restaurant's Wi-Fi shares one IP, so callers pick limits for a busy dining room. The table of callers is bounded: once full,
 * lapsed entries are dropped, and a new caller is refused while it is still full, so a LAN client can't grow it without end.
 */
export function guestRateLimiter(now = () => Date.now()) {
  const windows = new Map<string, { until: number; count: number }>();
  return (req: Pick<FastifyRequest, "ip">, action: string, limit: number): void => {
    const at = now(), key = `${action}:${req.ip}`;
    if (windows.size >= MAX_KEYS) {
      for (const [entry, value] of windows) if (value.until <= at) windows.delete(entry);
      if (windows.size >= MAX_KEYS && !windows.has(key)) throw httpError(429, "Please wait a minute and try again");
    }
    let value = windows.get(key);
    if (!value || value.until <= at) { value = { until: at + WINDOW_MS, count: 0 }; windows.set(key, value); }
    if (++value.count > limit) throw httpError(429, "Please wait a minute and try again");
  };
}
