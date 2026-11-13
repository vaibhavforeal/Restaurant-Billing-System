export type StartRoute = "/first-run" | "/set-owner" | "/lock" | "/bill";

/**
 * Where the app opens: first run until the cafe is saved; Set owner PIN when the cafe has no active owner (set-up was
 * interrupted between saving the cafe and its owner); the lock screen until someone signs in; then billing.
 */
/** Screens anyone may see without signing in. Everything else, inside the tabs or not, needs a signed-in person. */
const OPEN = new Set(["lock", "first-run", "set-owner"]);

/**
 * The root guard: where to send someone on a screen they should not see (after the idle lock or Switch staff left a
 * screen under the lock, or a deep link), or null to stay. `segment` is the route's first segment; undefined is the start.
 */
export function guardRoute(segment: string | undefined, state: { hasCafe: boolean; hasOwner: boolean; signedIn: boolean }): StartRoute | null {
  if (segment === undefined) return null;
  if (!state.hasCafe) return segment === "first-run" ? null : "/first-run";
  if (!state.hasOwner) return segment === "set-owner" ? null : "/set-owner";
  if (!state.signedIn && !OPEN.has(segment)) return "/lock";
  return null;
}

export function startRoute(state: { hasCafe: boolean; hasOwner: boolean; signedIn: boolean }): StartRoute {
  if (!state.hasCafe) return "/first-run";
  if (!state.hasOwner) return "/set-owner";
  return state.signedIn ? "/bill" : "/lock";
}
