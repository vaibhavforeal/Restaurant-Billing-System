export type StartRoute = "/first-run" | "/set-owner" | "/lock" | "/bill";

/**
 * Where the app opens: first run until the cafe is saved; Set owner PIN when the cafe has no active owner (set-up was
 * interrupted between saving the cafe and its owner); the lock screen until someone signs in; then billing.
 */
export function startRoute(state: { hasCafe: boolean; hasOwner: boolean; signedIn: boolean }): StartRoute {
  if (!state.hasCafe) return "/first-run";
  if (!state.hasOwner) return "/set-owner";
  return state.signedIn ? "/bill" : "/lock";
}
