import type { LiveHub } from "./live/types.js";

// Minimal structural types for the Cloudflare bindings, so Worker source needs no @cloudflare/workers-types.
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T>(): Promise<T | null>;
  all<T>(): Promise<{ results: T[] }>;
  run(): Promise<{ meta: { changes: number } }>;
}
export interface D1Like {
  prepare(sql: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<unknown[]>;
}
export interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }
/** The Workers Static Assets binding that serves the portal's web app. */
export interface AssetsBinding { fetch(request: Request): Promise<Response> }
export interface Env {
  DB: D1Like;
  LIMITER: RateLimiter;
  /** Portal sign-in attempts per address; falls back to LIMITER when the binding is missing. */
  LOGIN_LIMITER?: RateLimiter;
  /** The built portal (apps/portal/dist); absent in tests and before the portal is built. */
  ASSETS?: AssetsBinding;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET: string;
  LICENSE_SIGNING_KEY: string;
  /** Live sockets for support (chat pushes, remote access). Set by hosts that run a hub (apps/licensing-node); absent on Cloudflare for now. */
  LIVE?: LiveHub;
  /** TURN relay for remote sessions: comma-separated URLs (turn:host:3478?transport=udp,turns:host:5349) and the coturn static-auth-secret. */
  TURN_URLS?: string;
  TURN_SECRET?: string;
}
