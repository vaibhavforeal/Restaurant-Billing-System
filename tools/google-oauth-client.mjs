import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Google OAuth "Desktop app" client for Drive backups.
 * Order: FORKFLOW_GOOGLE_CLIENT_ID/_SECRET, then the JSON named by FORKFLOW_GOOGLE_CLIENT_FILE,
 * then a single client_secret_*.json downloaded from Cloud console into `root` (git-ignored).
 * Returns empty strings when none is configured; the build then ships without Drive backup.
 */
export function googleOAuthClient(root) {
  const id = process.env.FORKFLOW_GOOGLE_CLIENT_ID, secret = process.env.FORKFLOW_GOOGLE_CLIENT_SECRET;
  if (id) return { clientId: id, clientSecret: secret ?? "", source: "environment" };
  let file = process.env.FORKFLOW_GOOGLE_CLIENT_FILE;
  if (!file) {
    const found = existsSync(root) ? readdirSync(root).filter((name) => /^client_secret_.+\.json$/.test(name)) : [];
    if (found.length > 1) throw new Error(`Several Google OAuth client files in ${root}; keep one or set FORKFLOW_GOOGLE_CLIENT_FILE`);
    if (found.length) file = join(root, found[0]);
  }
  if (!file) return { clientId: "", clientSecret: "", source: "none" };
  const client = JSON.parse(readFileSync(file, "utf8")).installed;
  if (!client?.client_id) throw new Error(`${file} is not a Google "Desktop app" OAuth client`);
  return { clientId: client.client_id, clientSecret: client.client_secret ?? "", source: file };
}
