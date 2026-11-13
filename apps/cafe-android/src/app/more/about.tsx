import Constants from "expo-constants";
import { getDevice } from "@masalapos/cafe-data";
import { useData } from "../../db/provider";
import { ListRow, Screen } from "../../ui";

/** App version, and this device's name and bill series letter. */
export default function About() {
  const device = useData(getDevice);
  return (
    <Screen title="About" edges={["top", "bottom"]}>
      <ListRow title="MasalaPOS Cafe" subtitle={`Version ${Constants.expoConfig?.version ?? "unknown"}`} />
      <ListRow title="This device" subtitle={device ? `${device.name}, bill series ${device.seriesLetter}` : "Not set up"} />
      <ListRow title="Your data" subtitle="Bills, menu and settings are kept on this phone and work without internet." />
    </Screen>
  );
}
