import { Redirect } from "expo-router";
import { getCafe, hasActiveOwner } from "@masalapos/cafe-data";
import { useData } from "../db/provider";
import { useCurrentStaff } from "../staff/session";
import { startRoute } from "../start-route";

export default function Start() {
  const hasCafe = useData((db) => getCafe(db) !== null);
  const hasOwner = useData(hasActiveOwner);
  const signedIn = useCurrentStaff() !== null;
  return <Redirect href={startRoute({ hasCafe, hasOwner, signedIn })} />;
}
