/** AbortSignal.timeout / AbortSignal.any need a recent browser; older WebViews on cheap tablets throw instead. These fall back to a timer and listeners. */

/** A signal that aborts after `ms` milliseconds. */
export function timeoutSignal(ms: number): AbortSignal {
  if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException("The operation timed out.", "TimeoutError")), ms);
  controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
  return controller.signal;
}

/** A signal that aborts as soon as any of `signals` does, with the same reason. */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
  const controller = new AbortController();
  const first = signals.find((signal) => signal.aborted);
  if (first) { controller.abort(first.reason); return controller.signal; }
  const stop = () => signals.forEach((signal) => signal.removeEventListener("abort", onAbort));
  function onAbort(this: AbortSignal) { stop(); controller.abort(this.reason); }
  signals.forEach((signal) => signal.addEventListener("abort", onAbort, { once: true }));
  return controller.signal;
}

/** `signal` combined with a timeout: aborts when the caller cancels or `ms` pass, whichever is first. */
export function withTimeout(signal: AbortSignal, ms: number): AbortSignal {
  return anySignal([signal, timeoutSignal(ms)]);
}
