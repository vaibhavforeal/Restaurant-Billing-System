// The per-installation secret: 32 random bytes as 64 lowercase hex characters. The Worker keeps only its SHA-256; it is never logged or echoed.
export const SECRET_HEADER = "x-forkflow-installation-secret";

const SECRET_FORMAT = /^[a-f0-9]{64}$/;
export const isWellFormedSecret = (value: string | null): value is string => value !== null && SECRET_FORMAT.test(value);

export async function sha256Hex(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Compares every character (no early exit on the first difference); strings of different lengths are never equal. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
