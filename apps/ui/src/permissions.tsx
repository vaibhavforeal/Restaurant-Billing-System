import { createContext, useCallback, useContext, type ReactNode } from "react";
import type { User } from "./api";

/** Whether this person holds a permission: their role's, with the admin's changes for them applied (resolved by the server). */
export const userCan = (user: Pick<User, "permissions"> | null | undefined, slug: string): boolean => !!user?.permissions?.includes(slug);

const CurrentUser = createContext<User | null>(null);

/** Makes the signed-in person available to every screen, so each can ask what they may do. */
export function CurrentUserProvider({ user, children }: { user: User; children: ReactNode }) {
  return <CurrentUser.Provider value={user}>{children}</CurrentUser.Provider>;
}

/** `can("bills.refund")`: false outside a signed-in session. */
export function useCan(): (slug: string) => boolean {
  const user = useContext(CurrentUser);
  return useCallback((slug: string) => userCan(user, slug), [user]);
}
