import { useEffect, useState } from "react";
import Constants from "expo-constants";
import { getDevice, hashPin, PIN_HASH_ITERATIONS } from "@masalapos/cafe-data";
import { useData } from "../../db/provider";
import { ListRow, Screen } from "../../ui";

/** App version, this device's name and bill series letter, and how long one PIN check takes on this phone. */
export default function About() {
  const device = useData(getDevice);
  const [pinCheck, setPinCheck] = useState("Measuring…");
  useEffect(() => {
    const start = Date.now();
    hashPin("1234").then(
      () => setPinCheck(`${Date.now() - start} ms at ${PIN_HASH_ITERATIONS} rounds`),
      () => setPinCheck("Could not measure"),
    );
  }, []);
  return (
    <Screen title="About" edges={["top", "bottom"]}>
      <ListRow title="MasalaPOS Cafe" subtitle={`Version ${Constants.expoConfig?.version ?? "unknown"}`} />
      <ListRow title="This device" subtitle={device ? `${device.name}, bill series ${device.seriesLetter}` : "Not set up"} />
      <ListRow title="Your data" subtitle="Bills, menu and settings are kept on this phone and work without internet." />
      <ListRow title="PIN check" subtitle={pinCheck} />
    </Screen>
  );
}
