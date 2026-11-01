// Staff passwords: PBKDF2-SHA256 through WebCrypto, stored as "pbkdf2-sha256$<iterations>$<salt>$<hash>" (base64url). Shared with
// tools/portal-create-admin.ts, which hashes the first admin's password on the operator's PC.

/** Cloudflare Workers refuse PBKDF2 above 100,000 iterations (they throw rather than clamp), so this is the ceiling, not a choice. */
export const PBKDF2_ITERATIONS = 100_000;
const SCHEME = "pbkdf2-sha256";
export const MIN_PASSWORD_LENGTH = 10;

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (text: string) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256));
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `${SCHEME}$${iterations}$${b64url(salt)}$${b64url(await derive(password, salt, iterations))}`;
}

/** Compares in constant time; a malformed stored hash never matches. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, rounds, salt, hash] = stored.split("$");
  const iterations = Number(rounds);
  if (scheme !== SCHEME || !Number.isInteger(iterations) || iterations < 1 || iterations > PBKDF2_ITERATIONS || !salt || !hash) return false;
  let expected: Uint8Array, actual: Uint8Array;
  try { expected = fromB64url(hash); actual = await derive(password, fromB64url(salt), iterations); } catch { return false; }
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual[i]! ^ expected[i]!;
  return diff === 0;
}

/** Hashed once per isolate, so an unknown email costs the same time as a wrong password. */
let dummy: Promise<string> | null = null;
export const dummyHash = () => (dummy ??= hashPassword("not a real password"));
