// Who may open a live socket, decided from the upgrade request alone, with the same credentials as the matching HTTP routes:
//   /portal/api/live    staff session cookie (support roles), from the portal's own pages
//   /support/live       the restaurant's mp_support cookie, from the chat page
//   /v1/counter/live    a counter's installation id and secret headers (the POS server, not a browser)
//   /v1/remote/agent    a remote session's one-time token (the sharing window on the PC)
import type { Env } from "../env.js";
import { currentUser } from "../portal/auth.js";
import { roleCan } from "../portal/shared.js";
import { SECRET_HEADER, verifyInstallationSecret } from "../secret.js";
import { getInstallation } from "../store.js";
import { claimAgentToken } from "../support/remote.js";
import { currentVisitor } from "../support/visitor.js";
import type { HubDeps } from "./hub.js";
import type { Peer } from "./types.js";

export const LIVE_PATHS = ["/portal/api/live", "/support/live", "/v1/counter/live", "/v1/remote/agent", "/v1/connector/live"] as const;
export const INSTALLATION_HEADER = "x-masalapos-installation-id";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The peer this upgrade request speaks for, or null to refuse it. `request.url` must carry the service's public origin. */
export async function authorizeLive(request: Request, env: Pick<Env, "TURN_URLS" | "TURN_SECRET">, deps: HubDeps): Promise<Peer | null> {
  const url = new URL(request.url);
  // Browser sockets must come from the service's own pages: another site can't ride a cookie into one.
  const sameOrigin = request.headers.get("origin") === url.origin;
  switch (url.pathname) {
    case "/portal/api/live": {
      if (!sameOrigin) return null;
      const session = await currentUser(deps, request);
      if (!session || session.user.mustChangePassword) return null;
      if (!roleCan(session.user.role, "support.chat") && !roleCan(session.user.role, "support.remote")) return null;
      return { kind: "staff", user: session.user, tokenHash: session.tokenHash };
    }
    case "/support/live": {
      if (!sameOrigin) return null;
      const visitor = await currentVisitor(deps, request);
      return visitor ? { kind: "visitor", ...visitor } : null;
    }
    case "/v1/counter/live": {
      const installationId = request.headers.get(INSTALLATION_HEADER) ?? "";
      if (!UUID.test(installationId)) return null;
      const found = await getInstallation(deps.db, installationId);
      const installation = found ? await verifyInstallationSecret(deps.db, found, request.headers.get(SECRET_HEADER)) : null;
      return installation?.customerId ? { kind: "counter", installationId, customerId: installation.customerId } : null;
    }
    case "/v1/remote/agent": {
      const claimed = await claimAgentToken({ db: deps.db, now: deps.now, live: undefined, env }, url.searchParams.get("t") ?? "");
      return claimed?.installationId ? { kind: "agent", sessionId: claimed.sessionId, installationId: claimed.installationId } : null;
    }
    case "/v1/connector/live": {
      const claimed = await claimAgentToken({ db: deps.db, now: deps.now, live: undefined, env }, url.searchParams.get("t") ?? "", "connector");
      return claimed?.chatId ? { kind: "connector", sessionId: claimed.sessionId, chatId: claimed.chatId, installationId: claimed.installationId } : null;
    }
    default: return null;
  }
}
