// Test-only: staff accounts written straight into the store, and a signed-in client for the portal API.
import type { Env } from "../env.js";
import { hashPassword } from "../portal/passwords.js";
import type { Role } from "../portal/shared.js";
import { ORIGIN, send } from "./harness.js";

export const PASSWORD = "correct horse battery";

export interface SeededStaff { id: string; email: string; name: string; role: Role }

/** Hashed with few iterations so tests stay fast; the hash records its own count, so sign-in verifies it the same way. */
export async function seedStaff(env: Env, role: Role, over: { email?: string; name?: string; password?: string; mustChange?: boolean } = {}): Promise<SeededStaff> {
  const id = crypto.randomUUID(), name = over.name ?? `${role[0]!.toUpperCase()}${role.slice(1)} ${id.slice(0, 4)}`;
  const email = over.email ?? `${role}-${id.slice(0, 8)}@masalapos.test`, now = Date.now();
  await env.DB.prepare(`INSERT INTO staff_users (id, email, name, role, password_hash, must_change_password, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, email, name, role, await hashPassword(over.password ?? PASSWORD, 1000), over.mustChange ? 1 : 0, now, now).run();
  return { id, email, name, role };
}

export interface PortalClient {
  cookie: string;
  /** A portal API call as this staff member; non-GET requests carry the portal's own Origin. */
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  /** The same, expecting success, returning the parsed body. */
  ok<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T>;
}

export function client(env: Env, cookie: string): PortalClient {
  const call = (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
    send(env, method, `/portal/api${path}`, body, { ...(method === "GET" ? {} : { origin: ORIGIN }), ...(cookie ? { cookie } : {}), ...headers });
  return {
    cookie, call,
    async ok(method, path, body) {
      const res = await call(method, path, body);
      if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
      return await res.json() as never;
    },
  };
}

export async function signIn(env: Env, staff: { email: string }, password = PASSWORD): Promise<PortalClient> {
  const res = await send(env, "POST", "/portal/api/login", { email: staff.email, password }, { origin: ORIGIN });
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status} ${await res.text()}`);
  return client(env, res.headers.get("set-cookie")!.split(";")[0]!);
}

/** A signed-in client for a fresh staff member with this role. */
export async function as(env: Env, role: Role, over: Parameters<typeof seedStaff>[2] = {}): Promise<PortalClient & { staff: SeededStaff }> {
  const staff = await seedStaff(env, role, over);
  return Object.assign(await signIn(env, staff, over.password), { staff });
}
