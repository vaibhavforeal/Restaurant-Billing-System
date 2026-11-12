import type { CafeSettings } from "@masalapos/cafe-data";
import { useCafeDraft } from "../../settings/useCafeDraft";
import { Banner, Button, Choice, Screen } from "../../ui";

const MODES = [{ value: "included", label: "Prices include GST" }, { value: "exclusive", label: "GST added on top" }, { value: "none", label: "No GST" }] as const;
const RATES = ([0, 5, 12, 18, 28] as const).map((r) => ({ value: r, label: `${r}%` }));
const ROUNDING = [{ value: "rupee", label: "Nearest rupee" }, { value: "half", label: "Nearest 50 paise" }, { value: "off", label: "No rounding" }] as const;

/** How GST is charged and how totals are rounded. Changes apply to new bills only. */
export default function TaxSettings() {
  const { draft, set, save, saved } = useCafeDraft();
  return (
    <Screen title="Tax" edges={["top", "bottom"]}>
      <Choice label="GST on menu prices" options={MODES} value={draft.gstMode} onChange={set("gstMode")} />
      {draft.gstMode !== "none" ? (
        <Choice label="Usual GST rate" options={RATES} value={draft.defaultGstRate} onChange={(v) => set("defaultGstRate")(v as CafeSettings["defaultGstRate"])} />
      ) : null}
      <Choice label="Round the total to" options={ROUNDING} value={draft.roundOff} onChange={set("roundOff")} />
      {saved ? <Banner tone="success" text="Saved. New bills use these settings; old bills keep theirs." /> : null}
      <Button label="Save" size="lg" onPress={save} />
    </Screen>
  );
}
