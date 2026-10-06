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
  /**
   * Start a PIN check: false while this IP is cooling down; otherwise the attempt is counted as a failure right away,
   * before the (async) PIN verification, so parallel wrong PINs cannot all pass the cooldown check. Call
   * clearPinFailures when the PIN turns out to be right.
   */
  beginPinAttempt(ip: string): boolean;
}

/** An independent per-IP failure counter; each server instance has one for sign-in and a separate one for admin approval. */
export function createPinThrottle(): PinThrottle {
  const state = new Map<string, ThrottleState>();
  const pinCooldown = (ip: string): boolean => {
    const entry = state.get(ip);
    return entry !== undefined && Date.now() < entry.cooldownUntil;
  };
  const recordPinFailure = (ip: string): void => {
    const current = state.get(ip) ?? { failures: 0, cooldownUntil: 0 };
    current.failures += 1;
    if (current.failures >= THROTTLE_AFTER) {
      const cooldownMs = Math.min(THROTTLE_START_MS * Math.pow(2, current.failures - THROTTLE_AFTER), THROTTLE_MAX_MS);
      current.cooldownUntil = Date.now() + cooldownMs;
    }
    state.set(ip, current);
  };
  return {
    pinCooldown,
    recordPinFailure,
    clearPinFailures(ip) {
      state.delete(ip);
    },
    beginPinAttempt(ip) {
      if (pinCooldown(ip)) return false;
      recordPinFailure(ip);
      return true;
    },
  };
}

declare module "fastify" {
  interface FastifyInstance {
    loginThrottle: PinThrottle;
    approvalThrottle: PinThrottle;
  }
}
