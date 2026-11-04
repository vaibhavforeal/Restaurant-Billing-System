import { connectorRoutes } from "../connector/routes.js";
import type { Env } from "../env.js";
import type { Deps } from "../issue.js";
import { activityRoutes } from "./activity.js";
import { changePassword, currentUser, signIn, signOut } from "./auth.js";
import { assertCan, type Route } from "./context.js";
import { HttpError, json, notFound, serveSpa } from "./http.js";
import { customersRoutes } from "./customers.js";
import { installationsRoutes } from "./installations.js";
import { followUpRoutes } from "./followups.js";
import { homeRoutes } from "./home.js";
import { invoiceRoutes } from "./invoices.js";
import { leadRoutes } from "./leads.js";
import { orderRoutes } from "./order-routes.js";
import { paymentRoutes } from "./payments.js";
import { remoteRoutes } from "./remote-routes.js";
import { renewalRoutes } from "./renewals.js";
import { reportRoutes } from "./reports.js";
import { searchRoutes } from "./search.js";
import { settingsRoutes } from "./settings.js";
import { supportChatRoutes } from "./support-chats.js";
import { ticketRoutes } from "./tickets.js";
import { usersRoutes } from "./users.js";

const ROUTES: Route[] = [...usersRoutes, ...settingsRoutes, ...activityRoutes, ...customersRoutes, ...orderRoutes, ...installationsRoutes, ...searchRoutes, ...paymentRoutes, ...invoiceRoutes,
  ...leadRoutes, ...followUpRoutes, ...ticketRoutes, ...renewalRoutes, ...homeRoutes, ...reportRoutes,
  ...supportChatRoutes, ...remoteRoutes, ...connectorRoutes];

/** Everything under /portal: the JSON API for signed-in staff, and the web app itself. */
export async function portalRoute(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  return url.pathname.startsWith("/portal/api/") ? api(request, env, deps, url) : serveSpa(request, env, url, "/portal", "portal app");
}

async function api(request: Request, env: Env, deps: Deps, url: URL): Promise<Response> {
  try {
    // Every change must come from the portal's own pages: another site cannot drive it with a staff member's cookie.
    if (request.method !== "GET" && request.headers.get("origin") !== url.origin) throw new HttpError(403, "Changes must come from the portal itself", "bad_origin");
    const p = url.pathname.slice("/portal/api".length);
    if (request.method === "POST" && p === "/login") return await signIn(deps, env, request);
    const session = await currentUser(deps, request);
    if (!session) throw new HttpError(401, "Sign in again", "signed_out");
    const { user, tokenHash } = session;
    if (request.method === "POST" && p === "/logout") return await signOut(deps, tokenHash);
    if (request.method === "GET" && p === "/me") return json({ user });
    if (request.method === "POST" && p === "/password") return await changePassword(deps, request, user, tokenHash);
    if (user.mustChangePassword) throw new HttpError(403, "Choose a new password first", "password_change_required");
    for (const route of ROUTES) {
      if (route.method !== request.method) continue;
      const match = url.pathname.match(route.path);
      if (!match) continue;
      if (route.permission) assertCan(user, route.permission);
      return await route.handler({ deps, env, request, url, user, tokenHash, params: match.slice(1) });
    }
    throw notFound("That page");
  } catch (error) {
    if (error instanceof HttpError) return json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
    throw error;
  }
}

