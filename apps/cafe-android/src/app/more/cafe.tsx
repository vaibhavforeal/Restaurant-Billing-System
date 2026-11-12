import { useCafeDraft } from "../../settings/useCafeDraft";
import { Banner, Button, Field, Screen } from "../../ui";

/** Name, address, phone, GSTIN, FSSAI and UPI ID. Changes apply to new bills only. */
export default function CafeDetails() {
  const { draft, set, errors, save, saved } = useCafeDraft();
  return (
    <Screen title="Cafe details" edges={["top", "bottom"]}>
      <Field label="Cafe name" value={draft.name} onChangeText={set("name")} error={errors.name ?? null} maxLength={60} autoCapitalize="words" />
      <Field label="Address" value={draft.address} onChangeText={set("address")} error={errors.address ?? null} multiline maxLength={200} />
      <Field label="Phone" value={draft.phone} onChangeText={set("phone")} error={errors.phone ?? null} keyboardType="phone-pad" maxLength={20} />
      <Field label="GSTIN" value={draft.gstin} onChangeText={set("gstin")} error={errors.gstin ?? null} autoCapitalize="characters" maxLength={15}
        help="Leave blank if the cafe is not registered for GST." />
      <Field label="FSSAI licence" value={draft.fssai} onChangeText={set("fssai")} error={errors.fssai ?? null} keyboardType="number-pad" maxLength={14} />
      <Field label="UPI ID" value={draft.upiId} onChangeText={set("upiId")} error={errors.upiId ?? null} autoCapitalize="none" autoCorrect={false}
        placeholder="cafe@bank" help="Shows a QR code for the exact amount on the payment screen." />
      {saved ? <Banner tone="success" text="Saved. New bills use these details; old bills keep theirs." /> : null}
      <Button label="Save" size="lg" onPress={save} />
    </Screen>
  );
}
