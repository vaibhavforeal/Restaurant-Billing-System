import { ActivityAlertSettings } from "./ActivityAlertSettings";
import { AiSuggestionSettings } from "./AiSuggestionSettings";
import { BillSettings } from "./BillSettings";
import { TableSettings } from "./TableSettings";
import { useCan } from "../permissions";
import { useModules } from "../modules";
import { DiscountCaps } from "./DiscountCaps";
import { CustomerTypesSettings } from "./CustomerTypesSettings";
import { LoyaltySettings } from "./LoyaltySettings";
import { DeviceSettings } from "./DeviceSettings";
import { settingsForSave } from "../settings-save";
import { useAction } from "../use-action";
import { Fragment, useEffect, useRef, useState } from "react";
import { GST_STATES } from "@masalapos/domain/restaurant-profile";
import { apiFetch } from "../api";
import { DevicesSettings } from "./DevicesSettings";
import type { DevicesTabId } from "../devices-model";
import { SystemSettings } from "./SystemSettings";
import { LicenseSettings } from "./LicenseSettings";
import { KeyboardSettings } from "./KeyboardSettings";
import { OrderTypes } from "./OrderTypes";
import { UpdateSettings } from "./UpdateSettings";
import { SupportSettings } from "../support";
import { Icon } from "../Icon";
import { initialSettingsSection, SETTINGS_SECTIONS, visibleSettingsSections, type SettingsSectionId } from "../settings-sections";
import "../settings-cards.css";
import type { SettingsData } from "../types";

const EMPTY_SETTINGS: SettingsData = { restaurantName: "", address: "", city: "", stateCode: "", pincode: "", phone: "", gstin: "", fssai: "", receiptHeader: "", receiptFooter: "", billShowFssai: true, billShowCustomer: true, billShowTable: true, billShowServedBy: false, billShowItemGst: false, upiId: "", receiptStyle: "classic", gstMode: "included", gstRate: 5, kotEditPrint: "ask", holdOrdersEnabled: true, popularItemsEnabled: true, popularByTimeEnabled: true, orderedTogetherEnabled: true, customerUsualEnabled: true, sacCode: "996331", zomatoGstin: "", invoicePrefix: "", roundOff: "rupee", serviceChargeBp: 0, packagingChargePaise: 0, serviceChargeLabel: "", packagingChargeLabel: "", packagingPerItem: false, orderWarnMinutes: 15, orderLateMinutes: 25, kotPrintWithKds: true, paymentModes: ["cash", "card", "upi"], qrAutoAccept: false, dayStartHour: 0 };

const SETTINGS_FIELDS: Array<{ key: "restaurantName" | "address" | "city" | "pincode" | "phone" | "gstin" | "fssai"; label: string; inputMode?: "numeric" | "tel" }> = [
  { key: "restaurantName", label: "Restaurant name" },
  { key: "address", label: "Street address" },
  { key: "city", label: "City" },
  { key: "pincode", label: "PIN code", inputMode: "numeric" },
  { key: "phone", label: "Phone", inputMode: "tel" },
  { key: "gstin", label: "GSTIN" },
  { key: "fssai", label: "FSSAI licence no." },
];

const PROFILE_KEYS = ["restaurantName", "address", "city", "stateCode", "pincode", "phone", "gstin", "fssai"] as const;

const STATE_OPTIONS = Object.entries(GST_STATES).sort(([, a], [, b]) => a.localeCompare(b));

/** Opens on a grid of section cards; a `section` opens that card directly, e.g. Plan from a Marketplace card that needs a different plan. */
export function Settings({ section }: { section?: SettingsSectionId | undefined } = {}) {
  const can = useCan();
  const canManage = can("settings.manage");
  const { isActive } = useModules();
  const crmActive = isActive("crm");
  const [tableBusy, setTableBusy] = useState(false);
  const [active, setActive] = useState<SettingsSectionId | null>(() => initialSettingsSection(section));
  const sectionHeading = useRef<HTMLHeadingElement>(null);
  const returnToCard = useRef<SettingsSectionId | null>(null);
  // Profile section
  const [form, setForm] = useState<SettingsData>(EMPTY_SETTINGS);
  const [profileStatus, setProfileStatus] = useState<"" | "saved" | "error">("");
  const [profileError, setProfileError] = useState("");

  // Which tab the Devices card opens on, when another card sends the user to it.
  const [devicesTab, setDevicesTab] = useState<DevicesTabId | undefined>(undefined);

  // Common
  const { busy, error, setError, run } = useAction();
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!loaded) return; // the sections render only after the settings load
    if (active) sectionHeading.current?.focus();
    else if (returnToCard.current) document.querySelector<HTMLElement>(`[data-section="${returnToCard.current}"]`)?.focus();
  }, [active, loaded]);

  // The Bill settings and AI suggestions cards save their own fields, so the profile card re-reads the settings whenever it opens.
  useEffect(() => {
    if (active !== "profile" || !loaded) return;
    apiFetch<{ settings: SettingsData }>("/api/settings")
      // Keep what is already typed in the profile fields; everything else is refreshed.
      .then((r) => setForm((previous) => ({ ...r.settings, ...Object.fromEntries(PROFILE_KEYS.map((key) => [key, previous[key]])) })))
      .catch(() => { setProfileError("Could not refresh the settings"); setProfileStatus("error"); });
  }, [active, loaded]);

  // Load all data on mount
  useEffect(() => {
    void loadAll();
  }, []);

  async function loadAll() {
    // Staff who may only see printers get the Devices card alone; the restaurant's settings are not theirs to read.
    if (!canManage) { setLoaded(true); return; }
    try {
      const settingsRes = await apiFetch<{ settings: SettingsData }>("/api/settings");
      setForm(settingsRes.settings);
      setLoaded(true);
      setError("");
    } catch {
      setError("Failed to load settings");
    }
  }

  // Profile actions
  function saveProfile() {
    setProfileStatus("");
    void run(async () => {
      try {
        const { settings } = await apiFetch<{ settings: SettingsData }>("/api/settings", { method: "PUT", body: JSON.stringify(settingsForSave(form)) });
        setForm(settings);
        setProfileStatus("saved");
      } catch (e) {
        setProfileError(e instanceof Error ? e.message : "Could not save restaurant settings");
        setProfileStatus("error");
      }
    });
  }

  if (!loaded) return <section className="panel">{error ? <><p role="alert">{error}</p><button onClick={() => void loadAll()}>Retry</button></> : <p role="status">Loading settings…</p>}</section>;

  return (
    <div className="screen settings-screen">
      <div className="page-header"><div><h2>Settings</h2></div></div>
      {active === null ? (
        <ul className="settings-cards">
          {visibleSettingsSections({ canManageSettings: canManage, canReadPrinters: can("printers.read"), canManageTables: can("tables.manage"), crmActive }).map(({ id, title, blurb, icon }) => (
            <li key={id}>
              <button type="button" className="settings-card" data-section={id} onClick={() => { returnToCard.current = id; setDevicesTab(undefined); setActive(id); }}>
                <span className="settings-card-icon"><Icon name={icon} size={22} /></span>
                <span className="settings-card-title">{title}</span>
                <span className="settings-card-blurb">{blurb}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : <>
      <div className="settings-detail-head">
        <button type="button" disabled={tableBusy} onClick={() => setActive(null)}>← Settings</button>
        <h3 ref={sectionHeading} tabIndex={-1}>{SETTINGS_SECTIONS.find((item) => item.id === active)?.title}</h3>
      </div>
      <div className="pos-section settings-detail">
      {active === "shortcuts" && <KeyboardSettings />}
      {active === "order-types" && <OrderTypes />}
      {active === "tables" && <TableSettings onBusyChange={setTableBusy} />}
      {active === "updates" && <UpdateSettings />}
      {active === "support" && <SupportSettings />}
      {active === "bill" && <BillSettings onOpenPrinters={() => { setDevicesTab("printers"); setActive("devices"); }} />}
      {active === "ai-suggestions" && <AiSuggestionSettings />}
      {active === "discounts" && <>
        <DiscountCaps />
        {crmActive ? <CustomerTypesSettings /> : <p className="panel muted">Customer-type discounts come with the CRM &amp; Loyalty add-on.</p>}
      </>}
      {active === "loyalty" && (crmActive ? <LoyaltySettings /> : <p className="panel muted">Loyalty comes with the CRM &amp; Loyalty add-on. Turn it on in the Marketplace.</p>)}
      {active === "device" && <DeviceSettings />}
      {/* Profile section */}
      {active === "profile" && <div className="panel">

        <div className="settings-form">
          {SETTINGS_FIELDS.map(({ key, label, inputMode }) => <Fragment key={key}>
            <label style={{ display: "grid", gap: 4 }}>
              {label}
              <input value={form[key]} inputMode={inputMode} onChange={(e) => setForm({ ...form, [key]: e.target.value })} />
            </label>
            {key === "city" && <label style={{ display: "grid", gap: 4 }}>
              State
              <select value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })} disabled={busy}>
                {!form.stateCode && <option value="">Choose the state</option>}
                {STATE_OPTIONS.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
              </select>
            </label>}
          </Fragment>)}


          <button
            className="primary" onClick={() => void saveProfile()}
            style={{ fontWeight: 700 }}
            disabled={!form.restaurantName.trim() || busy}
          >
            Save
          </button>
          <div role={profileStatus === "error" ? "alert" : "status"} style={{ minHeight: 20, color: profileStatus === "error" ? "var(--danger-text, crimson)" : "var(--success-text, green)" }}>
            {profileStatus === "saved" && "Saved ✓"}
            {profileStatus === "error" && profileError}
          </div>
        </div>
        <ActivityAlertSettings />
      </div>}

      {active === "devices" && <DevicesSettings initialTab={devicesTab} />}
      {active === "backups" && <SystemSettings />}
      {active === "plan" && <LicenseSettings />}
      </div>
      </>}
    </div>
  );
}
