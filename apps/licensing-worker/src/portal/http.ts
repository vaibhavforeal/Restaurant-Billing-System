import type { z } from "zod";

/** A refusal the portal shows as it is: `message` is plain words for staff, `code` is for the app's logic. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

export const NO_STORE = { "cache-control": "no-store" };
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
