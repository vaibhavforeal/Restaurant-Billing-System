import { randomBytes } from "node:crypto";

const RAND_BITS = 74n; // rand_a (12) + rand_b (62)
const RAND_MAX = (1n << RAND_BITS) - 1n;
const RAND_B_MASK = (1n << 62n) - 1n;

let lastMs = -1;
let lastRand = 0n;

function randomTail(): bigint {
  return BigInt(`0x${randomBytes(10).toString("hex")}`) & RAND_MAX;
}

/**
 * RFC 9562 UUIDv7 — 48-bit big-endian millisecond timestamp + 74 random bits,
 * with the random field used as a monotonic counter inside a single millisecond.
 *
 * Generated client-side so offline terminals never collide, and strictly
 * time-ordered so a burst of writes during service sorts in creation order and
 * inserts stay index-friendly. A backwards clock step (NTP correction) does not
 * break ordering: we hold the last timestamp and keep counting.
 */
export function uuidv7(): string {
  const now = Date.now();

  if (now > lastMs) {
    lastMs = now;
    lastRand = randomTail();
  } else if (lastRand < RAND_MAX) {
    lastRand += 1n;
  } else {
    lastMs += 1; // counter exhausted within the millisecond — borrow from the next
    lastRand = randomTail();
  }

  const value =
    (BigInt(lastMs) << 80n) | // unix_ts_ms   bits 127..80
    (0x7n << 76n) | //          version       bits  79..76
    ((lastRand >> 62n) << 64n) | // rand_a    bits  75..64
    (0b10n << 62n) | //         variant       bits  63..62
    (lastRand & RAND_B_MASK); //  rand_b      bits  61..0

  const hex = value.toString(16).padStart(32, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
