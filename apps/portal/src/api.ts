import type { ApiErrorBody } from "../../licensing-worker/src/portal/api-types";

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

/** Called when the session has ended, so the app can show the sign-in screen. */
export const session = { onSignedOut: null as (() => void) | null, onPasswordChange: null as (() => void) | null };

/** A portal API call. The session cookie travels on its own; refusals come back as ApiError with the server's plain-words message. */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
  let res: Response;
  try {
    res = await fetch(`/portal/api${path}`, { ...init, headers, credentials: "same-origin", signal: init.signal ?? AbortSignal.timeout(20_000) });
  } catch {
    throw new ApiError(0, "Couldn't reach the portal. Check the internet connection and try again.");
  }
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => null) as (ApiErrorBody & Record<string, unknown>) | null;
  if (!res.ok) {
    if (res.status === 401 && path !== "/login") session.onSignedOut?.();
    if (body?.code === "password_change_required") session.onPasswordChange?.();
    throw new ApiError(res.status, body?.error ?? `The portal answered ${res.status}`, body?.code);
  }
  return body as T;
}

export const post = <T>(path: string, body?: unknown) => api<T>(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body: JSON.stringify(body) });
export const put = <T>(path: string, body: unknown) => api<T>(path, { method: "PUT", body: JSON.stringify(body) });
export const del = <T>(path: string) => api<T>(path, { method: "DELETE" });

/** A query string from the values that are set. */
export function query(values: Record<string, string | number | boolean | null | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== "" && value !== false) params.set(key, String(value));
  const text = params.toString();
  return text ? `?${text}` : "";
}
