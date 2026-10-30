import type { Env } from "../env.js";
import type { Deps } from "../issue.js";
import { activityRoutes } from "./activity.js";
import { changePassword, currentUser, signIn, signOut } from "./auth.js";
import { assertCan, type Route } from "./context.js";
import { HttpError, json, notFound, SECURITY_HEADERS } from "./http.js";
import { settingsRoutes } from "./settings.js";
import { usersRoutes } from "./users.js";

const ROUTES: Route[] = [...usersRoutes, ...settingsRoutes, ...activityRoutes];

/** Everything under /portal: the JSON API for signed-in staff, and the web app itself. */
export async function portalRoute(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url);
  return url.pathname.startsWith("/portal/api/") ? api(request, env, deps, url) : serveApp(request, env, url);
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

/**
 * The portal web app from Workers Static Assets (apps/portal, built into dist/portal). A path without a file extension is a page of
 * the app, so it gets the app's index; the Worker adds the security headers, which asset responses cannot carry by themselves.
 */
async function serveApp(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not_found" }, 404);
  if (url.pathname === "/portal") return Response.redirect(`${url.origin}/portal/`, 308);
  if (!env.ASSETS) return new Response("The portal app is not built. Run: npm run build -w @forkflow/portal", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
  const file = /\/[^/]+\.[a-z0-9]+$/i.test(url.pathname);
  // "/portal/" and not "/portal/index.html": the assets layer redirects the latter to the former.
  const asset = await env.ASSETS.fetch(file ? request : new Request(new URL("/portal/", url), request));
  const response = new Response(asset.body, asset);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(name, value);
  // Pages always revalidate so a deploy reaches staff at once; the hashed scripts and styles they load can be cached.
  if (!file) response.headers.set("cache-control", "no-cache");
  return response;
}
