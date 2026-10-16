export class CloudError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** The browser stores only the HttpOnly session cookie; CSRF lives in memory. */
export class CloudApi {
  csrfToken: string | null = null;
  onUnauthorized: (() => void) | null = null;
  constructor(private transport: typeof fetch = fetch) {}
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    if (init.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && this.csrfToken) headers.set("x-csrf-token", this.csrfToken);
    let response: Response;
    const transport = this.transport;
    try { response = await transport(`/v1${path}`, { ...init, headers, credentials: "include", cache: "no-store", signal: init.signal ?? AbortSignal.timeout(15000) }); }
    catch { throw new CloudError(0, "Cloud unavailable. Check your internet connection and try again."); }
    const body = response.status === 204 ? undefined : await response.json().catch(() => undefined);
    if (!response.ok) {
      if (response.status === 401) { this.csrfToken = null; this.onUnauthorized?.(); }
      throw new CloudError(response.status, typeof body?.error === "string" ? body.error : `Cloud request failed (${response.status}). Try again.`);
    }
    if (typeof body?.csrfToken === "string") this.csrfToken = body.csrfToken;
    return body as T;
  }
  post<T>(path: string, body: unknown = {}): Promise<T> { return this.request<T>(path, { method: "POST", body: JSON.stringify(body) }); }
}
export const api = new CloudApi();
export const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong. Try again.";
export const dateTime = (value: number | null | undefined) => value ? new Date(value).toLocaleString() : "Not yet received";
export function freshness(lastSeenAt: number | null, now = Date.now()): { state: "unknown" | "recent" | "stale"; label: string } {
  if (!lastSeenAt) return { state: "unknown", label: "Awaiting first upload" };
  if (now - lastSeenAt <= 5 * 60_000) return { state: "recent", label: "Recently connected" };
  return { state: "stale", label: "Outlet has not connected recently" };
}
export function parseRupees(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error("Enter a non-negative price with at most two decimal places.");
  const [whole, fraction = ""] = value.trim().split(".");
  const paise = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Price is too large.");
  return Number(paise);
}
export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  try {
    const parsed = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(value));
    if (!parsed) return "—";
    const fraction = parsed[3] ?? "", rounded = BigInt(parsed[2]!) + (fraction && fraction[0]! >= "5" ? 1n : 0n);
    const paise = parsed[1] ? -rounded : rounded, negative = paise < 0n, absolute = negative ? -paise : paise;
    return `${negative ? "−" : ""}₹${(absolute / 100n).toLocaleString("en-US")}.${(absolute % 100n).toString().padStart(2, "0")}`;
  } catch { return "—"; }
}

export interface Membership { organizationId: string; name: string; role: "owner" | "manager" | "viewer" }
export interface Session { user: { id: string; email: string; platformRole: "owner" | "platform_admin" }; csrfToken: string; memberships?: Membership[] }
export interface Outlet { id: string; organizationId: string; name: string; installationId: string | null; lastSeenAt: number | null; acknowledgedSequence: number; epoch: string | null; initialSyncComplete?: boolean }
export interface OutletStatus extends Outlet { pendingCommands: number; subscription: Record<string, unknown> | null; outstandingUploads?: number }
export interface MirrorRecord { key: Record<string, string | number>; row: Record<string, unknown>; revision: number }
export interface Records { records: MirrorRecord[]; acknowledgedSequence: number; lastSeenAt: number | null; nextCursor?: string | null }
export interface Command { id: string; kind: string; targetId?: string; expectedRevision: number; payload: Record<string, unknown>; requestedBy: string; createdAt: number; status: "pending" | "applied" | "conflict" | "rejected" | "cancelled"; revision?: number; error?: string }
export interface Report { currency: string; timezone?: string; totals: Record<string, string | number>; paymentMethods: { method: string; amountPaise: string }[]; daily: { date: string; billCount: number; grandTotalPaise: string }[]; acknowledgedSequence: number; lastSeenAt: number | null }
