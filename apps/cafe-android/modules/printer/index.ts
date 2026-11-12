import { requireNativeModule } from "expo";

/** The Kotlin module in ./android. Bytes cross as base64 text; src/print/printer.ts wraps this with typed calls. */
export interface MasalaposPrinterNative {
  bluetoothState(): Promise<"ready" | "off" | "no_permission" | "unsupported">;
  pairedPrinters(): Promise<Array<{ name: string; address: string }>>;
  print(transport: "bluetooth" | "network", address: string, host: string, port: number, base64: string): Promise<void>;
}

export default requireNativeModule<MasalaposPrinterNative>("MasalaposPrinter");
