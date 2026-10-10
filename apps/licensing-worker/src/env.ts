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
export type Period = "monthly" | "yearly";
export interface Env {
  DB: D1Like;
  LIMITER: RateLimiter;
  RAZORPAY_KEY_ID: string;
  RAZORPAY_KEY_SECRET: string;
  RAZORPAY_WEBHOOK_SECRET: string;
  LICENSE_SIGNING_KEY: string;
  RAZORPAY_PLAN_BASIC_MONTHLY: string;
  RAZORPAY_PLAN_BASIC_YEARLY: string;
  RAZORPAY_PLAN_PRO_MONTHLY: string;
  RAZORPAY_PLAN_PRO_YEARLY: string;
}
