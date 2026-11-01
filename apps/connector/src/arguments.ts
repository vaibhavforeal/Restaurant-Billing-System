export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export function invitationFromFilename(filename: string): string | null {
  return /(?:^|[\\/])MasalaPOS-Support-C-\d+-([A-Za-z0-9_-]{43})(?: \(\d+\))?\.exe$/i.exec(filename)?.[1] ?? null;
}
export function consentAllowed(requested: "view" | "control", decision: string, elevated: boolean, adminPrompts: boolean): boolean {
  return ["deny", "view", "control"].includes(decision) && !(decision === "control" && requested === "view") && !(adminPrompts && (!elevated || decision === "deny"));
}
