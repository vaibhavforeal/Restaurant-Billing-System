import { expect, test } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

test("the right password verifies and a wrong one does not", async () => {
  const stored = await hashPassword("chai-latte-42");

  expect(await verifyPassword("chai-latte-42", stored)).toBe(true);
  expect(await verifyPassword("chai-latte-43", stored)).toBe(false);
});

test("the same password hashes differently every time", async () => {
  const [first, second] = await Promise.all([hashPassword("same"), hashPassword("same")]);

  // Distinct salts, so a stolen table cannot be cracked in one pass.
  expect(first).not.toBe(second);
  expect(await verifyPassword("same", second)).toBe(true);
});

test("the stored digest never contains the password", async () => {
  const stored = await hashPassword("plaintext-secret");

  expect(stored).not.toContain("plaintext-secret");
  expect(stored.startsWith("scrypt$")).toBe(true);
});

test("a malformed digest is rejected rather than throwing", async () => {
  expect(await verifyPassword("anything", "not-a-real-digest")).toBe(false);
});
