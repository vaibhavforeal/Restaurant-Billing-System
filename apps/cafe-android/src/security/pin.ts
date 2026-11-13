import * as ExpoCrypto from "expo-crypto";

/** An owner PIN is 4 to 6 digits. */
export function isValidPin(pin: string): boolean {
  return /^\d{4,6}$/.test(pin);
}

/** SHA-256 hex of `${salt}:${pin}`. The salt is the device id, so the same PIN hashes differently on each phone. */
export function hashPin(pin: string, salt: string): Promise<string> {
  return ExpoCrypto.digestStringAsync(ExpoCrypto.CryptoDigestAlgorithm.SHA256, `${salt}:${pin}`);
}
