import { PrinterSetup } from "../../print/PrinterSetup";
import { useScreenGate } from "../../staff/useApproval";
import { Screen } from "../../ui";

/** Printers need a manager or the owner; they are asked once on entry. */
export default function PrintersScreen() {
  const { allowed, sheet } = useScreenGate("printers.manage", "Change printers");
  return (
    <Screen title="Printers" edges={["top", "bottom"]}>
      {allowed ? <PrinterSetup /> : null}
      {sheet}
    </Screen>
  );
}
