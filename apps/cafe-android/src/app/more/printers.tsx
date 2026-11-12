import { PrinterSetup } from "../../print/PrinterSetup";
import { Screen } from "../../ui";

export default function PrintersScreen() {
  return (
    <Screen title="Printers" edges={["top", "bottom"]}>
      <PrinterSetup />
    </Screen>
  );
}
