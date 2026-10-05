const TOKEN_KEY = typeof location !== "undefined" && /^\/kitchen\/?$/.test(location.pathname) ? "forkflow.kitchen.token" : "forkflow.token";
const DEVICE_KEY = "forkflow.device.v1";
export function deviceCredential(): string {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value || !/^[a-f0-9]{64}$/.test(value)) {
    value = Array.from(crypto.getRandomValues(new Uint8Array(32)), (n) => n.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(DEVICE_KEY, value);
  }
  return value;
}
export function authHeaders() {
  return { authorization: `Bearer ${session.token ?? ""}`, "x-forkflow-device": deviceCredential() };
}

export const session = {
  onUnauthorized: null as (() => void) | null,

  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },

  set(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  },

  clear() {
    localStorage.removeItem(TOKEN_KEY);
    this.onUnauthorized?.();
  },
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** fetch with the session token attached; clears the session on a 401. */
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("x-forkflow-device", deviceCredential());
  if (init?.body) headers.set("content-type", "application/json");
  const token = session.token;
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers, signal: init?.signal ?? AbortSignal.timeout(15_000) });
  if (res.status === 401) session.clear();
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error === "validation" ? (body.issues?.[0]?.message ?? "Check the form values") : (body.error ?? res.statusText));
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface User {
  id: string;
  name: string;
  role: "admin" | "cashier" | "waiter" | "kitchen";
}
