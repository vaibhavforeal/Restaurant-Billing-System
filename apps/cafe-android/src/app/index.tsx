import { Redirect } from "expo-router";
import { getCafe } from "@masalapos/cafe-data";
import { useData } from "../db/provider";

/** First run until the cafe is saved; then straight to billing. */
export default function Start() {
  const hasCafe = useData((db) => getCafe(db) !== null);
  return <Redirect href={hasCafe ? "/bill" : "/first-run"} />;
}
