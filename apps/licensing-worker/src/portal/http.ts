import type { z } from "zod";
import type { Env } from "../env.js";

/** A refusal the portal shows as it is: `message` is plain words for staff, `code` is for the app's logic. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

const NO_STORE = { "cache-control": "no-store" };
/** Sent with every portal response, pages and API alike. */
export const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...NO_STORE, ...SECURITY_HEADERS, ...headers } });

/** The request body checked against `schema`; anything else is a 400 with the first problem in words. */
export async function readBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let body: unknown;
  try { body = await request.json(); } catch { throw new HttpError(400, "The request could not be read"); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".");
    throw new HttpError(400, field ? `Check ${field}: ${issue!.message}` : "Check the form values", "validation");
  }
  return parsed.data;
}

export const notFound = (what = "That record") => new HttpError(404, `${what} was not found`, "not_found");
export const conflict = (message: string, code = "conflict") => new HttpError(409, message, code);

/**
 * A web app from Workers Static Assets (apps/portal, built into dist/portal) under `base`: the staff portal or the support chat page.
 * A path without a file extension is a page of the app, so it gets the app's index; the Worker adds the security headers, which
 * asset responses cannot carry by themselves.
 */
export async function serveSpa(request: Request, env: Env, url: URL, base: "/portal" | "/support", name: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return json({ error: "not_found" }, 404);
  if (url.pathname === base) return Response.redirect(`${url.origin}${base}/${url.search}`, 308);
  if (!env.ASSETS) return new Response(`The ${name} is not built. Run: npm run build -w @masalapos/portal`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS } });
  const file = /\/[^/]+\.[a-z0-9]+$/i.test(url.pathname);
  // "<base>/" and not "<base>/index.html": the assets layer redirects the latter to the former.
  const asset = await env.ASSETS.fetch(file ? request : new Request(new URL(`${base}/`, url), request));
  const response = new Response(asset.body, asset);
  for (const [header, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(header, value);
  // Pages always revalidate so a deploy reaches everyone at once; the hashed scripts and styles they load can be cached.
  if (!file) response.headers.set("cache-control", "no-cache");
  return response;
}
