/**
 * Deterministic PRNG (ADR-0010): one stream per event, seeded by `session seed + event seq`.
 * Mulberry32 over a splitmix-style mix of (seed, seq). Never Math.random in the engine.
 */
export type Rng = {
  /** Float in [0, 1). */
  next(): number;
  /** Integer in [0, n). */
  int(n: number): number;
  /** New shuffled copy (Fisher–Yates). */
  shuffle<T>(items: readonly T[]): T[];
};

function mix(seed: number, seq: number): number {
  let h = (seed ^ Math.imul(seq + 0x9e3779b9, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

export function createRng(seed: number, seq: number): Rng {
  let a = mix(seed >>> 0, seq >>> 0);
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return {
    next,
    int,
    shuffle<T>(items: readonly T[]): T[] {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(i + 1);
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- i and j are in [0, length) by construction
        const tmp = out[i] as T;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same bounds argument
        out[i] = out[j] as T;
        out[j] = tmp;
      }
      return out;
    },
  };
}
