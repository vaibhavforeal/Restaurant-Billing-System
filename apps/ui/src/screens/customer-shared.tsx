import { useAction } from "../use-action";
import { useState } from "react";

export interface CustomerType { id: string; name: string; isActive: boolean; slabs: Array<{ minBillPaise: number; percent: number; validFrom: string | null; validTo: string | null }> }
export interface LoyaltySettings {
  enabled: boolean; pointsPer100: number; pointValuePaise: number; minRedeemPoints: number;
  expiryMonths: number; tiersEnabled: boolean; tierWindowMonths: number; maxRedeemPercent: number; feedbackEnabled: boolean;
}
export interface LoyaltyTier { id: string; name: string; minSpendPaise: number; earnMultiplier: number; isActive: boolean }

/** Runs one request at a time and shows its error or a done message. */
export function useRun() {
  const { busy, error, run: act } = useAction();
  const [message, setMessage] = useState("");
  async function run(action: () => Promise<unknown>, done = "Saved.") {
    setMessage("");
    if (await act(action)) setMessage(done);
  }
  const status = <>{error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}</>;
  return { busy, run, status };
}
