import { router } from "expo-router";
import { session } from "./session";

/** Signs out and shows the lock screen with nothing under it, so Back cannot reach the screen that was open. */
export function lockNow(): void {
  session.signOut();
  if (router.canDismiss()) router.dismissAll();
  router.replace("/lock");
}
