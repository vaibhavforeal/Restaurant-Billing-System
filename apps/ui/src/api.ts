const TOKEN_KEY = "forkflow.token";

export const session = {
  get token(): string | null {
    return localStorage.getItem(TOKEN_KEY);
  },
  set(token: string) {
    localStorage.setItem(TOKEN_KEY, token);
  },
  clear() {
    localStorage.removeItem(TOKEN_KEY);
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
  if (init?.body) headers.set("content-type", "application/json");
  const token = session.token;
  if (token) headers.set("authorization", `Bearer ${token}`);

  const res = await fetch(path, { ...init, headers });
  if (res.status === 401) session.clear();
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? res.statusText);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export interface User {
  id: string;
  name: string;
  role: "admin" | "cashier" | "waiter" | "kitchen";
}
