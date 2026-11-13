import { PrintProfile, type PrintProfileInput } from "@masalapos/domain/printer-schemas";
import { EscPos } from "./escpos.js";

export const DEFAULT_PROFILE: PrintProfileInput = { copies: 1, feedLines: 3, autoCut: true };

export function readProfile(json?: string): PrintProfileInput {
  return json ? PrintProfile.parse(JSON.parse(json)) : { ...DEFAULT_PROFILE };
}

export function finishSlip(pos: EscPos, profile: PrintProfileInput): Uint8Array {
  pos.feed(profile.feedLines);
  if (profile.autoCut) pos.cut();
  return pos.bytes();
}
