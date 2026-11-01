import { expect, it } from "vitest";
import { consentAllowed, invitationFromFilename } from "./arguments.js";
it("reads only a full connector filename, including browser duplicate suffixes", () => {
  const token = "a".repeat(43);
  expect(invitationFromFilename(`C:\\Downloads\\MasalaPOS-Support-C-1001-${token} (2).exe`)).toBe(token);
  expect(invitationFromFilename("renamed.exe")).toBeNull();
  expect(invitationFromFilename(`MasalaPOS-Support-C-1001-${token}.exe.bat`)).toBeNull();
});
it("does not upgrade view consent or enable admin prompts without elevation", () => {
  expect(consentAllowed("view","control",true,false)).toBe(false);
  expect(consentAllowed("control","view",true,true)).toBe(true);
  expect(consentAllowed("control","control",false,true)).toBe(false);
  expect(consentAllowed("control","deny",true,true)).toBe(false);
});
