import { RECEIPT_STYLES } from "@masalapos/domain/receipt-styles";
import { useOwnerConfirm } from "../../security/useOwnerConfirm";
import { useCafeDraft } from "../../settings/useCafeDraft";
import { Banner, Button, Choice, Field, Screen } from "../../ui";

const STYLE_LABELS: Record<(typeof RECEIPT_STYLES)[number], string> = { classic: "Classic", modern: "Modern", heritage: "Heritage", compact: "Compact" };

/** Bill prefix, header, footer and receipt style. Changes apply to new bills only. */
export default function ReceiptSettings() {
  const { draft, set, errors, save, saved } = useCafeDraft();
  const { confirm, prompt } = useOwnerConfirm("Save receipt settings");
  return (
    <Screen title="Receipt" edges={["top", "bottom"]}>
      <Field label="Bill prefix" value={draft.invoicePrefix} onChangeText={(t) => set("invoicePrefix")(t.toUpperCase())} error={errors.invoicePrefix ?? null}
        autoCapitalize="characters" maxLength={3} placeholder="CP"
        help="Up to three letters or digits. Changing the prefix starts a new series of bill numbers." />
      <Field label="Header" value={draft.receiptHeader} onChangeText={set("receiptHeader")} error={errors.receiptHeader ?? null} multiline maxLength={200}
        help="Printed under the cafe name, for example opening hours." />
      <Field label="Footer" value={draft.receiptFooter} onChangeText={set("receiptFooter")} error={errors.receiptFooter ?? null} multiline maxLength={200}
        placeholder="Thank you for visiting. Please come again." />
      <Choice label="Receipt style" options={RECEIPT_STYLES.map((s) => ({ value: s, label: STYLE_LABELS[s] }))} value={draft.receiptStyle} onChange={set("receiptStyle")} />
      {saved ? <Banner tone="success" text="Saved. New bills use these settings; old bills keep theirs." /> : null}
      <Button label="Save" size="lg" onPress={() => confirm(save)} accessibilityHint="Asks for the owner PIN" />
      {prompt}
    </Screen>
  );
}
