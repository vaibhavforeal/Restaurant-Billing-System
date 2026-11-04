import { useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { parseVendorCode } from "@masalapos/domain/vendor-codes";
import { GST_STATES, PROFILE_RULES, profileErrors, stateFromGstin, type ProfileField, type RestaurantProfileDraft } from "@masalapos/domain/restaurant-profile";
import { ApiError, apiFetch, session, type User } from "../api";
import { AuthLayout } from "./AuthLayout";
import { timeoutSignal } from "../abort-signal";
import "../setup.css";

/** How setup starts: "online" asks for the Customer ID and Order ID first; "offline" and "none" go straight to the restaurant details. */
export type SetupActivation = "online" | "offline" | "none";
interface Activated { customer: { code: string; name: string }; order: { code: string; plan: "basic" | "pro"; trial: boolean; expiresAt: number | null } }

const CHECK_CODES = "Check the Customer ID and Order ID. They are on the setup card MasalaPOS gave you.";

const STATE_OPTIONS = Object.entries(GST_STATES).sort(([, a], [, b]) => a.localeCompare(b));
const EMPTY_PROFILE: RestaurantProfileDraft = { restaurantName: "", address: "", city: "", stateCode: "", pincode: "", phone: "", gstin: "", fssai: "" };

export function Setup({ activation = "none", licensed = true, onDone }: { activation?: SetupActivation; licensed?: boolean; onDone: (user: User) => void }) {
  const [step, setStep] = useState<"activate" | "details" | "admin">(activation === "online" && !licensed ? "activate" : "details");
  const [activated, setActivated] = useState<Activated | null>(null);
  const [profile, setProfile] = useState<RestaurantProfileDraft>(EMPTY_PROFILE);
  const [adminName, setAdminName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  if (step === "activate") return <ActivateStep onSkip={() => setStep("details")} onActivated={(result) => {
    setActivated(result); setProfile((p) => ({ ...p, restaurantName: p.restaurantName || result.customer.name })); setStep("details");
  }} />;
  if (step === "details") return <DetailsStep activated={activated} profile={profile} onChange={setProfile} onNext={() => { setError(""); setStep("admin"); }} />;
  async function submit(e: FormEvent) {
    e.preventDefault(); if (lock.current) return;
    lock.current = true; setBusy(true);
    try {
      // The details and the admin go in one request, so an interrupted setup leaves nothing half-written.
      const { token, user } = await apiFetch<{ token: string; user: User }>("/api/setup", { method: "POST", body: JSON.stringify({ ...profile, adminName, pin }) });
      session.set(token); onDone(user);
    } catch (err) { setError(err instanceof ApiError && err.status === 400 && err.message ? err.message : "Setup failed. Check the fields and use a 4–6 digit PIN."); }
    finally { lock.current = false; setBusy(false); }
  }
  return <AuthLayout><form onSubmit={submit} className="auth-form"><h2>Your admin account</h2>
    <p>Step 2 of 2. The admin manages staff, the menu and settings for {profile.restaurantName.trim()}.</p>
    <label>Your name<input required autoFocus placeholder="Your name (admin)" value={adminName} onChange={(e) => setAdminName(e.target.value)} disabled={busy} /></label>
    <label>Admin PIN<input required type="password" placeholder="Admin PIN (4-6 digits)" value={pin} inputMode="numeric" pattern="[0-9]{4,6}" maxLength={6} onChange={(e) => setPin(e.target.value)} disabled={busy} /></label>
    <div className="error-message" role="alert">{error}</div><button type="submit" className="primary" style={{ width: "100%" }} disabled={busy}>{busy ? "Setting up…" : "Start"}</button>
    <button type="button" className="text-button" style={{ width: "100%", marginTop: 12 }} disabled={busy} onClick={() => setStep("details")}>Back to restaurant details</button>
  </form></AuthLayout>;
}

/** Step 1: what the bills print. Every field is checked before moving on; the server checks again on Start. */
function DetailsStep({ activated, profile, onChange, onNext }: { activated: Activated | null; profile: RestaurantProfileDraft; onChange: (p: RestaurantProfileDraft) => void; onNext: () => void }) {
  const [errors, setErrors] = useState<Partial<Record<ProfileField, string | undefined>>>({});
  const set = (name: ProfileField, value: string) => {
    const next = { ...profile, [name]: value };
    // A GSTIN names its state, so a valid one picks the state for the owner.
    if (name === "gstin") { const state = stateFromGstin(value); if (state) next.stateCode = state; }
    onChange(next);
    // Editing a field clears its message; the GSTIN can also fix the state, and the state can fix a GSTIN mismatch.
    setErrors((e) => ({ ...e, [name]: undefined, ...(name === "gstin" ? { stateCode: undefined } : name === "stateCode" ? { gstin: undefined } : {}) }));
  };
  function next(e: FormEvent) {
    e.preventDefault();
    const found = profileErrors(profile);
    setErrors(found);
    const first = (Object.keys(PROFILE_RULES) as ProfileField[]).find((name) => found[name]);
    if (first) { document.getElementById(`setup-${first}`)?.focus(); return; }
    onNext();
  }
  const described = (name: ProfileField) => errors[name] ? { "aria-invalid": true as const, "aria-describedby": `setup-${name}-error` } : {};
  const fieldError = (name: ProfileField) => errors[name] && <span id={`setup-${name}-error`} className="setup-field-error">{errors[name]}</span>;
  const field = (name: ProfileField, label: ReactNode, props: InputHTMLAttributes<HTMLInputElement> = {}) => <label>
    {label}
    <input id={`setup-${name}`} value={profile[name]} onChange={(e) => set(name, e.target.value)} {...described(name)} {...props} />
    {fieldError(name)}
  </label>;
  return <AuthLayout><form onSubmit={next} className="auth-form setup-details" noValidate><h2>Set up MasalaPOS</h2>
    {activated && <p role="status">Activated for {activated.customer.name}: {activated.order.plan === "pro" ? "Pro" : "Basic"}{activated.order.trial ? " trial" : ""}
      {activated.order.expiresAt !== null && <> until {new Date(activated.order.expiresAt).toLocaleDateString("en-IN", { dateStyle: "medium" })}</>}.</p>}
    <p>Step 1 of 2. These details print on every bill. You can change them later in Settings.</p>
    {field("restaurantName", "Restaurant name", { autoFocus: true, maxLength: 120, autoComplete: "organization" })}
    {field("address", "Street address", { maxLength: 300, placeholder: "Shop no., building, street, area", autoComplete: "street-address" })}
    <div className="setup-row">
      {field("city", "City", { maxLength: 80, autoComplete: "address-level2" })}
      <label>State
        <select id="setup-stateCode" value={profile.stateCode} onChange={(e) => set("stateCode", e.target.value)} {...described("stateCode")}>
          <option value="" disabled>Choose…</option>
          {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
        </select>
        {fieldError("stateCode")}
      </label>
    </div>
    <div className="setup-row">
      {field("pincode", "PIN code", { inputMode: "numeric", maxLength: 6, autoComplete: "postal-code" })}
      {field("phone", "Phone", { type: "tel", inputMode: "tel", maxLength: 16, autoComplete: "tel" })}
    </div>
    {field("gstin", <span>GSTIN <small>(optional)</small></span>, { maxLength: 15, autoCapitalize: "characters", spellCheck: false, autoComplete: "off" })}
    {field("fssai", <span>FSSAI licence no. <small>(optional)</small></span>, { inputMode: "numeric", maxLength: 14, autoComplete: "off" })}
    <button type="submit" className="primary" style={{ width: "100%" }}>Next</button>
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
      onActivated(await apiFetch<Activated>("/api/setup/activate", { method: "POST", body: JSON.stringify({ customerId, orderId }), signal: timeoutSignal(30_000) }));
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
