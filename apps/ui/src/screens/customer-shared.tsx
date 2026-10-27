import { useState } from "react";
import { ApiError } from "../api";

export interface CustomerType { id: string; name: string; isActive: boolean; slabs: Array<{ minBillPaise: number; percent: number; validFrom: string | null; validTo: string | null }> }
export interface LoyaltySettings {
  enabled: boolean; pointsPer100: number; pointValuePaise: number; minRedeemPoints: number;
  expiryMonths: number; tiersEnabled: boolean; tierWindowMonths: number; maxRedeemPercent: number; feedbackEnabled: boolean;
}
export interface LoyaltyTier { id: string; name: string; minSpendPaise: number; earnMultiplier: number; isActive: boolean }

/** Runs one request at a time and shows its error or a done message. */
export function useRun() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<unknown>, done = "Saved.") {
    if (busy) return;
    setBusy(true); setError(""); setMessage("");
    try { await action(); setMessage(done); }
    catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : "Request failed"); }
    finally { setBusy(false); }
  }
  const status = <>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}</>;
  return { busy, run, status };
}
