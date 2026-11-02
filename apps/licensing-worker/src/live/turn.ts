// ICE servers for one remote session. TURN credentials follow coturn's REST scheme (use-auth-secret): the username is
// "<expiry seconds>:<label>" and the password is base64(HMAC-SHA1(static-auth-secret, username)), so coturn needs no user database.
import type { Env } from "../env.js";

export interface IceServer { urls: string[]; username?: string; credential?: string }

/** Credentials outlive the longest session a little, so a relay never drops mid-session. */
const TURN_TTL_MS = 2 * 60 * 60 * 1000;

async function turnCredential(secret: string, username: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(username)));
  return btoa(String.fromCharCode(...mac));
}

/**
 * STUN and TURN on the service's own relay (no third-party servers). Without TURN configured the list is empty: sessions then only
 * connect when the two ends can reach each other directly (same network, or friendly NATs).
 */
export async function iceServersFor(env: Pick<Env, "TURN_URLS" | "TURN_SECRET">, label: string, now: number): Promise<IceServer[]> {
  const urls = (env.TURN_URLS ?? "").split(",").map((u) => u.trim()).filter((u) => /^(turns?|stun):/.test(u));
  if (!urls.length) return [];
  const stun = [...new Set(urls.filter((u) => u.startsWith("turn:")).map((u) => `stun:${u.slice(5).split("?")[0]}`))];
  const turn = urls.filter((u) => u.startsWith("turn"));
  const servers: IceServer[] = [];
  const plainStun = urls.filter((u) => u.startsWith("stun:"));
  if (stun.length || plainStun.length) servers.push({ urls: [...new Set([...plainStun, ...stun])] });
  if (turn.length && env.TURN_SECRET) {
    const username = `${Math.floor((now + TURN_TTL_MS) / 1000)}:${label}`;
    servers.push({ urls: turn, username, credential: await turnCredential(env.TURN_SECRET, username) });
  }
  return servers;
}
