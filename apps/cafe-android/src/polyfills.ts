import * as ExpoCrypto from "expo-crypto";

// uuidv7 in @masalapos/domain takes its random bytes from Web Crypto. Give Hermes one if it has none.
const g = globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(array: T) => T } };
if (!g.crypto) g.crypto = {};
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = <T extends ArrayBufferView>(array: T): T => {
    ExpoCrypto.getRandomValues(array as unknown as Uint8Array);
    return array;
  };
}
