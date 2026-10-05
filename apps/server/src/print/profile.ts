import { PrintProfile, type PrintProfileInput } from "@forkflow/domain";
import { EscPos } from "./escpos.js";

export const DEFAULT_PROFILE: PrintProfileInput = { copies: 1, feedLines: 3, autoCut: true };

export function readProfile(json: string | undefined): PrintProfileInput {
  return json ? PrintProfile.parse(JSON.parse(json)) : { ...DEFAULT_PROFILE };
}

export function finishSlip(pos: EscPos, profile: PrintProfileInput): Buffer {
  pos.feed(profile.feedLines);
  if (profile.autoCut) pos.cut();
  return pos.bytes();
}
