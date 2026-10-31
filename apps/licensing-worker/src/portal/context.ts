import type { Env } from "../env.js";
import type { Deps } from "../issue.js";
import { activityStatement, type ActivityEntry } from "../store.js";
import type { StaffUser } from "./auth.js";
import { HttpError } from "./http.js";
import { roleCan, type Permission } from "./shared.js";

/** One portal API request from a signed-in staff member. `params` are the route pattern's captures. */
export interface Ctx { deps: Deps; env: Env; request: Request; url: URL; user: StaffUser; tokenHash: string; params: string[] }
export interface Route { method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"; path: RegExp; permission?: Permission; handler: (ctx: Ctx) => Promise<Response> }

export function assertCan(user: StaffUser, permission: Permission): void {
  if (!roleCan(user.role, permission)) throw new HttpError(403, "Your role can't do that. Ask a portal admin.", "forbidden");
}

/** An activity row by the signed-in staff member, for the same batch as the change it describes. */
export const logBy = (ctx: Ctx, entry: Omit<ActivityEntry, "actorId">) => activityStatement(ctx.deps.db, ctx.deps.now(), { ...entry, actorId: ctx.user.id });

const ID = "([0-9a-f-]{36})";
/** A route pattern: `:id` matches a UUID, everything else is literal. */
export const path = (pattern: string) => new RegExp(`^/portal/api${pattern.replace(/:id/g, ID)}$`);

/** A query-string number, or the fallback when it is missing or not a whole number. */
export function queryInt(url: URL, name: string, fallback: number | null = null): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : fallback;
}
