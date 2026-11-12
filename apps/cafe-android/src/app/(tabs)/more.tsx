import { router } from "expo-router";
import { Screen, ListRow } from "../../ui";

export default function MoreScreen() {
  return (
    <Screen title="More">
      <ListRow title="Printers" subtitle="Receipt printer, paper width, test print" onPress={() => router.push("/more/printers")} />
      {__DEV__ ? <ListRow title="Self-check" subtitle="Development builds only" onPress={() => router.push("/self-check")} /> : null}
    </Screen>
  );
}
