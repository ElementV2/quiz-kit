import { describe, expect, it } from "vitest";
import * as fc from "fast-check";
import { createRng } from "./rng.ts";

describe("createRng", () => {
  it("is deterministic for the same (seed, seq)", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), (seed, seq) => {
        const a = createRng(seed, seq);
        const b = createRng(seed, seq);
        for (let i = 0; i < 5; i++) expect(a.next()).toBe(b.next());
      }),
    );
  });

  it("differs between consecutive seqs", () => {
    expect(createRng(42, 1).next()).not.toBe(createRng(42, 2).next());
  });

  it("stays in [0, 1) and int() in [0, n)", () => {
    fc.assert(
      fc.property(fc.nat(), fc.nat(), fc.integer({ min: 1, max: 100 }), (seed, seq, n) => {
        const r = createRng(seed, seq);
        const x = r.next();
        const k = r.int(n);
        expect(x >= 0 && x < 1 && Number.isInteger(k) && k >= 0 && k < n).toBe(true);
      }),
    );
  });

  it("shuffle is a permutation and does not mutate its input", () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.nat(), (xs, seed) => {
        const copy = [...xs];
        const out = createRng(seed, 1).shuffle(xs);
        expect(xs).toEqual(copy);
        expect(out.toSorted((a, b) => a - b)).toEqual(xs.toSorted((a, b) => a - b));
      }),
    );
  });

  it("is roughly uniform", () => {
    const r = createRng(7, 7);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 40_000; i++) {
      const k = r.int(4);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(9_000);
  });
});
