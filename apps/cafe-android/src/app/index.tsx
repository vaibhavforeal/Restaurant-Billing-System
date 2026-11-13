import { Redirect } from "expo-router";
import { getCafe, hasActiveOwner } from "@masalapos/cafe-data";
import { useData } from "../db/provider";
import { useCurrentStaff } from "../staff/session";

/** First run until the cafe is saved; Set owner PIN when it has no owner; the lock screen until someone signs in; then billing. */
export default function Start() {
  const hasCafe = useData((db) => getCafe(db) !== null);
  const hasOwner = useData(hasActiveOwner);
  const signedIn = useCurrentStaff() !== null;
  const href = !hasCafe ? "/first-run" : !hasOwner ? "/set-owner" : !signedIn ? "/lock" : "/bill";
  return <Redirect href={href} />;
}
