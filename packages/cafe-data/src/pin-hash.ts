import { pbkdf2Async } from "@noble/hashes/pbkdf2.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** PBKDF2 rounds for a new hash. Raising it later is free: `verifyPin` asks for a rehash of anything stored lower. */
export const PIN_HASH_ITERATIONS = 50_000;
const PREFIX = "pbkdf2-sha256";
const KEY_BYTES = 32;

/** A staff PIN is 4 to 6 digits. */
export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromBase64(text: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}
/** Constant time over equal-length inputs; unequal lengths are simply not equal. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>`, with a fresh 16-byte salt unless one is given. */
export async function hashPin(pin: string, opts: { iterations?: number; salt?: Uint8Array } = {}): Promise<string> {
  const iterations = opts.iterations ?? PIN_HASH_ITERATIONS;
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await pbkdf2Async(sha256, utf8ToBytes(pin), salt, { c: iterations, dkLen: KEY_BYTES });
  return `${PREFIX}$${iterations}$${toBase64(salt)}$${toBase64(key)}`;
}

/**
 * Checks a PIN against a stored hash. A value without the PBKDF2 prefix is the Phase 1 form (SHA-256 hex of
 * `deviceId:pin`); it is accepted only when `legacy` is given, and then always asks for a rehash. Never throws on a
 * malformed stored value.
 */
export async function verifyPin(pin: string, stored: string, legacy?: { deviceId: string }): Promise<{ ok: boolean; rehash: boolean }> {
  const no = { ok: false, rehash: false };
  if (!stored.startsWith(`${PREFIX}$`)) {
    if (!legacy || !/^[0-9a-f]{64}$/.test(stored)) return no;
    const hex = bytesToHex(sha256(utf8ToBytes(`${legacy.deviceId}:${pin}`)));
    return sameBytes(utf8ToBytes(hex), utf8ToBytes(stored)) ? { ok: true, rehash: true } : no;
  }
  const parts = stored.split("$");
  if (parts.length !== 4 || !/^\d+$/.test(parts[1]!)) return no;
  const iterations = Number(parts[1]);
  const salt = fromBase64(parts[2]!);
  const expected = fromBase64(parts[3]!);
  if (iterations < 1 || !salt?.length || expected?.length !== KEY_BYTES) return no;
  const key = await pbkdf2Async(sha256, utf8ToBytes(pin), salt, { c: iterations, dkLen: KEY_BYTES });
  if (!sameBytes(key, expected)) return no;
  return { ok: true, rehash: iterations < PIN_HASH_ITERATIONS };
}
