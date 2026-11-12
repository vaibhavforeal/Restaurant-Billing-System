import { router } from "expo-router";
import { Screen, ListRow } from "../../ui";

export default function MoreScreen() {
  return (
    <Screen title="More">
      {__DEV__ ? <ListRow title="Self-check" subtitle="Development builds only" onPress={() => router.push("/self-check")} /> : null}
    </Screen>
  );
}
