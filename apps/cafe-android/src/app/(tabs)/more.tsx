import { router, type Href } from "expo-router";
import type { CafePermission } from "@masalapos/cafe-data";
import { session, useCan, useCurrentStaff } from "../../staff/session";
import { ROLE_NAMES } from "../../staff/StaffPicker";
import { Button, ListRow, Screen } from "../../ui";

const ROWS: Array<{ title: string; subtitle: string; href: Href; needs?: CafePermission }> = [
  { title: "Staff", subtitle: "People, roles and PINs", href: "/more/staff", needs: "staff.manage" },
  { title: "Customers", subtitle: "Saved customers and their bills", href: "/more/customers" },
  { title: "Cafe details", subtitle: "Name, address, phone, GSTIN, FSSAI, UPI ID", href: "/more/cafe" },
  { title: "Tax", subtitle: "GST mode, usual rate, rounding", href: "/more/tax" },
  { title: "Receipt", subtitle: "Bill prefix, header, footer, style", href: "/more/receipt" },
  { title: "Printers", subtitle: "Receipt printer, paper width, test print", href: "/more/printers" },
  { title: "About", subtitle: "App version and this device", href: "/more/about" },
  { title: "Error log", subtitle: "Problems the app met, to share with MasalaPOS", href: "/more/errors" },
];

function switchStaff() {
  session.signOut();
  router.replace("/lock");
}

export default function MoreScreen() {
  const staff = useCurrentStaff();
  const canManageStaff = useCan("staff.manage");
  return (
    <Screen title="More" actions={<Button label="Switch staff" variant="secondary" onPress={switchStaff} />}>
      {staff ? <ListRow title={staff.name} subtitle={`Signed in as ${ROLE_NAMES[staff.role]}`} /> : null}
      {ROWS.filter((r) => r.needs !== "staff.manage" || canManageStaff)
        .map((r) => <ListRow key={r.title} title={r.title} subtitle={r.subtitle} onPress={() => router.push(r.href)} />)}
      {__DEV__ ? <ListRow title="Self-check" subtitle="Development builds only" onPress={() => router.push("/self-check")} /> : null}
    </Screen>
  );
}
