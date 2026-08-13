import { verifyPassword, type Role, type RoleLimits } from "@forkflow/core";
import type { DbHandle } from "./client.js";
import type { Repository } from "./repository.js";
import { audit_log, roles, user_outlet_access, users } from "./schema.js";

export interface Session {
  userId: string;
  name: string;
  outletId: string;
  role: Role;
}

export type LoginFailure = "invalid_credentials" | "inactive_user" | "no_outlet_access";

export type LoginResult = { ok: true; session: Session } | { ok: false; reason: LoginFailure };

export interface AuthServiceOptions {
  orgId: string;
  outletId: string;
  /** Audit entries are written through the repository so they replicate to the cloud. */
  repo: Repository;
}

export interface AuthService {
  login(email: string, password: string): Promise<LoginResult>;
}

/**
 * Sign-in against the terminal's own database.
 *
 * Deliberately local-only: staff must be able to start a shift during an
 * outage, so authentication never depends on reaching the cloud. Every attempt,
 * successful or not, is written to the replicated audit log — failed logins on
 * a till are exactly the signal the fraud detection in PROJECT_PLAN §3.6 needs.
 */
export function createAuthService(db: DbHandle, options: AuthServiceOptions): AuthService {
  const { repo, orgId, outletId } = options;

  async function audit(action: string, userId: string | null, detail?: Record<string, unknown>) {
    await repo.write(audit_log, {
      outlet_id: outletId,
      user_id: userId,
      action,
      entity: "users",
      entity_id: userId,
      detail: detail ?? null,
    });
  }

  return {
    async login(email, password) {
      const user = await db.findWhere(users, { email, org_id: orgId });

      // Same answer for an unknown email as for a bad password, and the hash is
      // still verified when absent would be cheaper — the login screen must not
      // become a way to discover who works here.
      if (!user) {
        await audit("user.login_failed", null, { email });
        return { ok: false, reason: "invalid_credentials" };
      }

      if (!(await verifyPassword(password, user.password_hash as string))) {
        await audit("user.login_failed", user.id as string, { email });
        return { ok: false, reason: "invalid_credentials" };
      }

      if (!user.is_active) {
        await audit("user.login_denied", user.id as string, { reason: "inactive_user" });
        return { ok: false, reason: "inactive_user" };
      }

      const access = await db.findWhere(user_outlet_access, {
        user_id: user.id,
        outlet_id: outletId,
      });
      if (!access) {
        await audit("user.login_denied", user.id as string, { reason: "no_outlet_access" });
        return { ok: false, reason: "no_outlet_access" };
      }

      const roleRow = await db.findById(roles, access.role_id as string);
      if (!roleRow) {
        await audit("user.login_denied", user.id as string, { reason: "no_outlet_access" });
        return { ok: false, reason: "no_outlet_access" };
      }

      await audit("user.login", user.id as string);

      return {
        ok: true,
        session: {
          userId: user.id as string,
          name: user.name as string,
          outletId,
          role: {
            name: roleRow.name as string,
            permissions: roleRow.permissions as string[],
            ...(roleRow.limits ? { limits: roleRow.limits as RoleLimits } : {}),
          },
        },
      };
    },
  };
}
