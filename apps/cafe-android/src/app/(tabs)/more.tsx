import { router, type Href } from "expo-router";
import { ListRow, Screen } from "../../ui";

const ROWS: Array<{ title: string; subtitle: string; href: Href }> = [
  { title: "Cafe details", subtitle: "Name, address, phone, GSTIN, FSSAI, UPI ID", href: "/more/cafe" },
  { title: "Tax", subtitle: "GST mode, usual rate, rounding", href: "/more/tax" },
  { title: "Receipt", subtitle: "Bill prefix, header, footer, style", href: "/more/receipt" },
  { title: "Printers", subtitle: "Receipt printer, paper width, test print", href: "/more/printers" },
  { title: "Owner PIN", subtitle: "Needed to void a bill", href: "/more/pin" },
  { title: "About", subtitle: "App version and this device", href: "/more/about" },
  { title: "Error log", subtitle: "Problems the app met, to share with MasalaPOS", href: "/more/errors" },
];

export default function MoreScreen() {
  return (
    <Screen title="More">
      {ROWS.map((r) => <ListRow key={r.title} title={r.title} subtitle={r.subtitle} onPress={() => router.push(r.href)} />)}
      {__DEV__ ? <ListRow title="Self-check" subtitle="Development builds only" onPress={() => router.push("/self-check")} /> : null}
    </Screen>
  );
}
