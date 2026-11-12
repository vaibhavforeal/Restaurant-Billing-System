import { Linking, PermissionsAndroid, Platform } from "react-native";
import Native from "../../modules/printer";
import { createPrintQueue, type PrintTarget } from "./print-queue";
import { toBase64 } from "./base64";

export const bluetoothState = () => Native.bluetoothState();
export const pairedPrinters = () => Native.pairedPrinters();

/** Asks for Bluetooth access on Android 12 and later; earlier versions grant it at install. */
export async function requestBluetoothPermission(): Promise<boolean> {
  if (Platform.OS !== "android" || Platform.Version < 31) return true;
  const result = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT);
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/** Opens Android's Bluetooth settings, where a printer is paired before the app can list it. */
export function openBluetoothSettings(): Promise<void> {
  return Linking.sendIntent("android.settings.BLUETOOTH_SETTINGS").catch(() => Linking.openSettings());
}

export function print(target: PrintTarget, bytes: Uint8Array): Promise<void> {
  return target.transport === "bluetooth"
    ? Native.print("bluetooth", target.address, "", 0, toBase64(bytes))
    : Native.print("network", "", target.host, target.port, toBase64(bytes));
}

/** The app's one print queue: jobs run one at a time, whichever screen queued them. */
export const printQueue = createPrintQueue(print);
