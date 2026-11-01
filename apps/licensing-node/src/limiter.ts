// A fixed-window, in-memory stand-in for the Workers rate-limit binding. One process serves everything, so memory is enough.
import type { RateLimiter } from "../../licensing-worker/src/env.js";

export function memoryLimiter(limit: number, periodSeconds: number, now: () => number = Date.now): RateLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    async limit({ key }) {
      const at = now();
      // Drop expired windows so the map cannot grow without bound.
      if (windows.size > 10_000) for (const [name, window] of windows) if (window.resetAt <= at) windows.delete(name);
      const window = windows.get(key);
      if (!window || window.resetAt <= at) { windows.set(key, { count: 1, resetAt: at + periodSeconds * 1000 }); return { success: true }; }
      window.count += 1;
      return { success: window.count <= limit };
    },
  };
}
