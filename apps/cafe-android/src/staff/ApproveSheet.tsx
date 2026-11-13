import { useState } from "react";
import { Text } from "react-native";
import { cafeCan, listStaff, type CafePermission, type Staff } from "@masalapos/cafe-data";
import { useData } from "../db/provider";
import { color, type } from "../theme/tokens";
import { Sheet } from "../ui";
import { PinPad } from "./PinPad";
import { StaffPicker } from "./StaffPicker";

/** Someone whose role holds `permission` picks their name and enters their PIN, for this one action. */
export function ApproveSheet({ visible, title, permission, onDone }: {
  visible: boolean; title: string; permission: CafePermission; onDone: (approverId: string | null) => void;
}) {
  const allowed = useData((db) => listStaff(db).filter((s) => cafeCan(s.role, permission)));
  const [picked, setPicked] = useState<Staff | null>(null);
  const finish = (id: string | null) => { setPicked(null); onDone(id); };
  return (
    <Sheet visible={visible} title={title} onClose={() => finish(null)}>
      {picked ? (
        <PinPad staff={picked} onSuccess={(s) => finish(s.id)} onBack={() => setPicked(null)} />
      ) : (
        <>
          <Text style={[type.body, { color: color.onSurfaceMuted }]}>A manager or the owner enters their PIN to allow this.</Text>
          <StaffPicker staff={allowed} onPick={setPicked} />
        </>
      )}
    </Sheet>
  );
}
