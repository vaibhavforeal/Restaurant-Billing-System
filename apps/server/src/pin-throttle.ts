const THROTTLE_AFTER = 5;
const THROTTLE_START_MS = 2000;
const THROTTLE_MAX_MS = 60000;

interface ThrottleState {
  failures: number;
  cooldownUntil: number;
}

export interface PinThrottle {
  /** True while this IP is cooling down after repeated wrong PINs. */
  pinCooldown(ip: string): boolean;
  recordPinFailure(ip: string): void;
  clearPinFailures(ip: string): void;
}

/** One throttle per server instance, shared by sign-in and admin approval so both draw on the same per-IP budget. */
export function createPinThrottle(): PinThrottle {
  const state = new Map<string, ThrottleState>();
  return {
    pinCooldown(ip) {
      const entry = state.get(ip);
      return entry !== undefined && Date.now() < entry.cooldownUntil;
    },
    recordPinFailure(ip) {
      const current = state.get(ip) ?? { failures: 0, cooldownUntil: 0 };
      current.failures += 1;
      if (current.failures >= THROTTLE_AFTER) {
        const cooldownMs = Math.min(THROTTLE_START_MS * Math.pow(2, current.failures - THROTTLE_AFTER), THROTTLE_MAX_MS);
        current.cooldownUntil = Date.now() + cooldownMs;
      }
      state.set(ip, current);
    },
    clearPinFailures(ip) {
      state.delete(ip);
    },
  };
}

declare module "fastify" {
  interface FastifyInstance {
    pinThrottle: PinThrottle;
  }
}
