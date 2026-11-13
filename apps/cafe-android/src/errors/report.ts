import type { ErrorEntry } from "@masalapos/cafe-data";

/** A message and stack from anything that was thrown. */
export function errorText(e: unknown): { message: string; stack: string | null } {
  if (e instanceof Error) return { message: `${e.name}: ${e.message}`, stack: e.stack ?? null };
  if (typeof e === "object" && e !== null && "message" in e) {
    const code = "code" in e && e.code ? ` (${String(e.code)})` : "";
    return { message: `${String(e.message)}${code}`, stack: null };
  }
  return { message: String(e), stack: null };
}

const stamp = (ms: number, tzOffsetMinutes: number) => new Date(ms + tzOffsetMinutes * 60_000).toISOString().slice(0, 16).replace("T", " ");

/** Plain text a tester can share: the app version, then each error with its time, where it happened and its stack. */
export function formatErrorReport(entries: readonly ErrorEntry[], info: { appVersion: string; tzOffsetMinutes: number }): string {
  const head = `MasalaPOS Cafe ${info.appVersion} error report (${entries.length} ${entries.length === 1 ? "error" : "errors"})`;
  if (!entries.length) return `${head}\n\nNo errors recorded.`;
  const body = [...entries].sort((a, b) => b.at - a.at).map((e) => {
    const stack = e.stack ? `\n${e.stack.split("\n").slice(0, 25).map((l) => `  ${l.trim()}`).join("\n")}` : "";
    return `${stamp(e.at, info.tzOffsetMinutes)}${e.context ? ` [${e.context}]` : ""} ${e.message}${stack}`;
  });
  return `${head}\n\n${body.join("\n\n")}`;
}
