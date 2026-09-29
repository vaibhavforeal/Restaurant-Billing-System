import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import lockfile from "proper-lockfile";

/** Windows named pipes are exclusive and released by the OS even on power loss
 * or forced termination. No stale heartbeat can admit a second SQLite writer. */
export async function lockDataDirectory(folder: string): Promise<() => Promise<void>> {
  if (process.platform !== "win32") return lockfile.lock(folder, { stale: 600_000, update: 5000, retries: 0 });
  const hash = createHash("sha256").update(realpathSync(folder).toLowerCase()).digest("hex");
  const server = createServer((socket) => socket.end());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(`\\\\.\\pipe\\forkflow-${hash}`, () => { server.off("error", reject); resolve(); });
  });
  return () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
