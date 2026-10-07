// ShapesOS — Phase 19B (WS=engine): deterministic randomness for the town.
// Commercial layer (entitlement dress_rehearsal). Architecture: lib/sim/engine.ts.
//
// Every random choice in the simulation comes from a stream derived from the
// run seed and a label ("weather", "resident:r012", "ads:day3"), so adding a
// new random draw in one place never shifts the draws anywhere else, and the
// same seed plus the same inputs always gives the same events, byte for byte.
// mulberry32 (public domain) for the stream, FNV-1a 32-bit to mix labels.
// Pure: no Math.random, no clock. Safe in the browser.

/** FNV-1a 32-bit hash of a string. */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number;
  /** True with probability p. */
  chance(p: number): boolean;
  /** One element (throws on an empty array). */
  pick<T>(items: readonly T[]): T;
  /** A new, independent stream for a sub-label. */
  fork(label: string): Rng;
}

class Mulberry32 implements Rng {
  private state: number;
  constructor(private readonly seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    if (max < min) throw new Error("rng.int: max < min");
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("rng.pick: empty");
    return items[Math.floor(this.next() * items.length)]!;
  }

  fork(label: string): Rng {
    return new Mulberry32(hash32(`${this.seed}:${label}`));
  }
}

/** A stream for (seed, label). The same pair always gives the same draws. */
export function rngFor(seed: number, label = "root"): Rng {
  return new Mulberry32(hash32(`${seed >>> 0}:${label}`));
}
