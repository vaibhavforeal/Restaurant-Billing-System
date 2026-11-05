import { readFileSync } from "node:fs";

/** A secret comes from NAME, or from the file named by NAME_FILE (systemd credentials, a root-only file). A trailing newline in the file is not part of it. */
export function readSecret(env: Record<string, string | undefined>, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  return env[name] ?? (file ? readFileSync(file, "utf8").trim() : undefined);
}

/** The AI assistant relay's settings: MasalaPOS's OpenRouter key (a secret, so NAME or NAME_FILE), the model and the fallback switch. All optional. */
export function aiEnv(env: Record<string, string | undefined>): { OPENROUTER_API_KEY?: string; OPENROUTER_MODEL?: string; OPENROUTER_FALLBACK?: string; OPENROUTER_BASE_URL?: string } {
  const key = readSecret(env, "OPENROUTER_API_KEY"), model = env["OPENROUTER_MODEL"], fallback = env["OPENROUTER_FALLBACK"], base = env["OPENROUTER_BASE_URL"];
  return { ...(key ? { OPENROUTER_API_KEY: key } : {}), ...(model ? { OPENROUTER_MODEL: model } : {}), ...(fallback ? { OPENROUTER_FALLBACK: fallback } : {}), ...(base ? { OPENROUTER_BASE_URL: base } : {}) };
}
