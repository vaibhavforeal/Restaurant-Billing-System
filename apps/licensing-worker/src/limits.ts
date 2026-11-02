import type { RateLimiter } from "./env.js";

/**
 * Whether this caller, by client address, is over `limiter`'s rate. The key is the address, under `prefix` when given, so each
 * surface keeps its own count. An unavailable limiter fails open (it must not take licensing or the portal down), or closed for
 * surfaces that hand out access (`failClosed`). Only the error's name is logged: no address, headers or body.
 */
export async function overLimit(limiter: RateLimiter, request: Request, prefix: string, failClosed = false): Promise<boolean> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  try { return !(await limiter.limit({ key: prefix ? `${prefix}:${ip}` : ip })).success; }
  catch (error) {
    console.error("licensing-worker: rate limiter unavailable:", error instanceof Error ? error.name : "unknown error");
    return failClosed;
  }
}
