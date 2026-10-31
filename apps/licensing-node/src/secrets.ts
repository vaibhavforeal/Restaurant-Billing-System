import { readFileSync } from "node:fs";

/** A secret comes from NAME, or from the file named by NAME_FILE (systemd credentials, a root-only file). A trailing newline in the file is not part of it. */
export function readSecret(env: Record<string, string | undefined>, name: string): string | undefined {
  const file = env[`${name}_FILE`];
  return env[name] ?? (file ? readFileSync(file, "utf8").trim() : undefined);
}
