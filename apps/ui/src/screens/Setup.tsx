import { useRef, useState, type FormEvent } from "react";
import { parseVendorCode } from "@masalapos/domain/vendor-codes";
import { apiFetch, session, type User } from "../api";
import { AuthLayout } from "./AuthLayout";

/** How setup starts: "online" asks for the Customer ID and Order ID first; "offline" and "none" go straight to the admin. */
export type SetupActivation = "online" | "offline" | "none";
interface Activated { customer: { code: string; name: string }; order: { code: string; plan: "basic" | "pro"; trial: boolean; expiresAt: number | null } }

const CHECK_CODES = "Check the Customer ID and Order ID. They are on the setup card MasalaPOS gave you.";

export function Setup({ activation = "none", licensed = true, onDone }: { activation?: SetupActivation; licensed?: boolean; onDone: (user: User) => void }) {
  const [step, setStep] = useState<"activate" | "admin">(activation === "online" && !licensed ? "activate" : "admin");
  const [activated, setActivated] = useState<Activated | null>(null);
  const [restaurantName, setRestaurantName] = useState("");
  const [adminName, setAdminName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  if (step === "activate") return <ActivateStep onSkip={() => setStep("admin")} onActivated={(result) => {
    setActivated(result); setRestaurantName((name) => name || result.customer.name); setStep("admin");
  }} />;
  async function submit(e: FormEvent) {
    e.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/setup", { method: "POST", body: JSON.stringify({ restaurantName, adminName, pin }) });
      session.set(token); onDone(user);
    } catch { setError("Setup failed. Check the fields and use a 4–6 digit PIN."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <AuthLayout><form onSubmit={submit} className="auth-form"><h2>Set up MasalaPOS</h2>
    {activated && <p role="status">Activated for {activated.customer.name}: {activated.order.plan === "pro" ? "Pro" : "Basic"}{activated.order.trial ? " trial" : ""}
      {activated.order.expiresAt !== null && <> until {new Date(activated.order.expiresAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</>}.</p>}
    <label>Restaurant name<input required placeholder="Restaurant name" value={restaurantName} onChange={(e) => setRestaurantName(e.target.value)} disabled={busy} /></label>
    <label>Your name<input required placeholder="Your name (admin)" value={adminName} onChange={(e) => setAdminName(e.target.value)} disabled={busy} /></label>
    <label>Admin PIN<input required type="password" placeholder="Admin PIN (4-6 digits)" value={pin} inputMode="numeric" pattern="[0-9]{4,6}" maxLength={6} onChange={(e) => setPin(e.target.value)} disabled={busy} /></label>
    <div className="error-message" role="alert">{error}</div><button type="submit" className="primary" style={{ width: "100%" }} disabled={busy}>{busy ? "Setting up…" : "Start"}</button>
  </form></AuthLayout>;
}

/** The first step on a commercial counter: the Customer ID and Order ID from MasalaPOS's setup card bring the licence down. */
function ActivateStep({ onActivated, onSkip }: { onActivated: (result: Activated) => void; onSkip: () => void }) {
  const [customerId, setCustomerId] = useState("");
  const [orderId, setOrderId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); if (lock.current) return;
    if (!parseVendorCode("customer", customerId) || !parseVendorCode("order", orderId)) { setError(CHECK_CODES); return; }
    lock.current = true; setBusy(true); setError("");
    try {
      onActivated(await apiFetch<Activated>("/api/setup/activate", { method: "POST", body: JSON.stringify({ customerId, orderId }), signal: AbortSignal.timeout(30_000) }));
    } catch (err) { setError(err instanceof Error ? err.message : "Activation failed. Try again."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <AuthLayout><form onSubmit={submit} className="auth-form"><h2>Activate MasalaPOS</h2>
    <p>Enter the Customer ID and Order ID from the setup card MasalaPOS gave you. This computer needs the internet for this step.</p>
    <label>Customer ID<input required autoFocus placeholder="FC-XXXX-XXX" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={40}
      value={customerId} onChange={(e) => setCustomerId(e.target.value)} disabled={busy} /></label>
    <label>Order ID<input required placeholder="FO-XXXX-XXX" autoCapitalize="characters" autoComplete="off" spellCheck={false} maxLength={40}
      value={orderId} onChange={(e) => setOrderId(e.target.value)} disabled={busy} /></label>
    <div className="error-message" role="alert">{error}</div>
    <button type="submit" className="primary" style={{ width: "100%" }} disabled={busy}>{busy ? "Activating…" : "Activate"}</button>
    <button type="button" className="text-button" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={onSkip}>No internet? Set up now and activate later</button>
  </form></AuthLayout>;
}
