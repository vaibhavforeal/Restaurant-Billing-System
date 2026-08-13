export interface HybridLogicalClockOptions {
  /** Stable identity of this terminal — the final tiebreaker between concurrent writes. */
  nodeId: string;
  now?: () => number;
}

/**
 * Hybrid Logical Clock — a wall-clock timestamp with a logical counter attached.
 *
 * Terminals in a restaurant have no shared clock, so plain `updated_at` cannot
 * order edits made on two tills. An HLC stays close to real time (so timestamps
 * remain human-meaningful) while guaranteeing that causally-later writes compare
 * greater, which is what makes last-write-wins resolution safe.
 */
export class HybridLogicalClock {
  readonly nodeId: string;
  readonly #now: () => number;
  #millis = 0;
  #counter = 0;

  constructor(options: HybridLogicalClockOptions) {
    this.nodeId = options.nodeId;
    this.#now = options.now ?? Date.now;
  }

  /** Stamp a local event. */
  tick(): string {
    const wall = this.#now();
    if (wall > this.#millis) {
      this.#millis = wall;
      this.#counter = 0;
    } else {
      // Wall clock stalled or stepped backwards — keep ordering via the counter.
      this.#counter += 1;
    }
    return encode(this.#millis, this.#counter, this.nodeId);
  }

  /**
   * Merge an incoming remote stamp, then stamp the local event that observed it.
   * Guarantees the returned stamp sorts after `remote`, which is what encodes
   * happens-before across terminals that never agreed on a wall clock.
   */
  receive(remote: string): string {
    const { millis: remoteMillis, counter: remoteCounter } = decode(remote);
    const wall = this.#now();
    const millis = Math.max(this.#millis, remoteMillis, wall);

    if (millis === this.#millis && millis === remoteMillis) {
      this.#counter = Math.max(this.#counter, remoteCounter) + 1;
    } else if (millis === this.#millis) {
      this.#counter += 1;
    } else if (millis === remoteMillis) {
      this.#counter = remoteCounter + 1;
    } else {
      this.#counter = 0; // the local wall clock is ahead of everything seen so far
    }

    this.#millis = millis;
    return encode(this.#millis, this.#counter, this.nodeId);
  }
}

export interface DecodedHlc {
  millis: number;
  counter: number;
  nodeId: string;
}

export function decode(stamp: string): DecodedHlc {
  const [millis, counter, ...node] = stamp.split("-");
  if (millis === undefined || counter === undefined || node.length === 0) {
    throw new Error(`Malformed HLC timestamp: "${stamp}"`);
  }
  return {
    millis: Number.parseInt(millis, 16),
    counter: Number.parseInt(counter, 16),
    nodeId: node.join("-"), // nodeIds may themselves contain "-"
  };
}

/**
 * Encodes to a fixed-width, lexicographically sortable string so it can be
 * ORDER BY'd directly in either dialect: `<48-bit ms hex>-<16-bit counter hex>-<nodeId>`.
 */
function encode(millis: number, counter: number, nodeId: string): string {
  return `${millis.toString(16).padStart(12, "0")}-${counter.toString(16).padStart(4, "0")}-${nodeId}`;
}
