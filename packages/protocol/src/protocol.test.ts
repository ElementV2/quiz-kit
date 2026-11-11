import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ClockEstimator,
  MAX_MESSAGE_BYTES,
  applyPatch,
  backoffDelay,
  checkViewSeq,
  pingSample,
  decodeClientMessage,
  decodeServerMessage,
  diff,
  encode,
  utf8Length,
} from "./index.ts";

describe("codec", () => {
  it("round-trips a valid intent", () => {
    const m = { t: "intent", key: "k_12345678", action: { type: "question.open" } } as const;
    expect(decodeClientMessage(encode(m))).toEqual({ ok: true, value: m });
  });

  it("rejects oversize messages before parsing", () => {
    const big = JSON.stringify({ t: "resync", pad: "x".repeat(MAX_MESSAGE_BYTES) });
    expect(decodeClientMessage(big)).toMatchObject({ ok: false, error: { code: "too-large" } });
  });

  it("counts UTF-8 bytes, not UTF-16 units", () => {
    expect(utf8Length("é")).toBe(2);
    expect(utf8Length("€")).toBe(3);
    expect(utf8Length("😀")).toBe(4);
    fc.assert(
      fc.property(fc.string({ unit: "grapheme" }), (s) => {
        expect(utf8Length(s)).toBe(Buffer.byteLength(s, "utf8"));
      }),
    );
  });

  it.each([
    ["not JSON", "{"],
    ["unknown type", JSON.stringify({ t: "steal-answers" })],
    ["extra field", JSON.stringify({ t: "resync", x: 1 })],
    ["bad action", JSON.stringify({ t: "intent", key: "k_12345678", action: { type: "nope" } })],
    ["short key", JSON.stringify({ t: "intent", key: "k", action: { type: "question.open" } })],
  ])("rejects %s", (_n, raw) => {
    expect(decodeClientMessage(raw)).toMatchObject({ ok: false, error: { code: "bad-message" } });
  });

  it("decodes server acks (ok and rejected)", () => {
    expect(decodeServerMessage(JSON.stringify({ t: "ack", key: "k_12345678", ok: true, eventSeq: 3 })).ok).toBe(true);
    expect(decodeServerMessage(JSON.stringify({ t: "ack", key: "k_12345678", ok: false, code: "wrong-phase", reason: "…" })).ok).toBe(true);
    expect(decodeServerMessage(JSON.stringify({ t: "ack", key: "k_12345678", ok: true })).ok).toBe(false);
  });
});

describe("patch (RFC 6902 subset)", () => {
  // Prototype keys are refused on purpose (tested below), so they are excluded from generated values.
  const json = fc.jsonValue({ maxDepth: 4 }).filter((v) => !/"(__proto__|constructor|prototype)":/.test(JSON.stringify(v)));

  it("apply(a, diff(a, b)) = b for any JSON values", () => {
    fc.assert(
      fc.property(json, json, (a, b) => {
        expect(applyPatch(a, diff(a, b))).toEqual({ ok: true, value: JSON.parse(JSON.stringify(b)) });
      }),
      { numRuns: 500 },
    );
  });

  it("does not mutate its input", () => {
    const a = { x: [1, 2], y: { z: 1 } };
    const copy = structuredClone(a);
    applyPatch(a, diff(a, { x: [1, 3], y: {} }));
    expect(a).toEqual(copy);
  });

  it("escapes ~ and / in keys (RFC 6901)", () => {
    const a = { "a/b": 1, "c~d": 2 };
    const ops = diff(a, { "a/b": 2, "c~d": 3 });
    expect(ops.map((o) => o.path)).toEqual(["/a~1b", "/c~0d"]);
    expect(applyPatch(a, ops)).toEqual({ ok: true, value: { "a/b": 2, "c~d": 3 } });
  });

  it("produces small patches for small changes", () => {
    const a = { phase: "open", leaderboard: [{ id: "p_1", total: 0 }], mechanic: { answeredCount: 3 } };
    expect(diff(a, { ...a, mechanic: { answeredCount: 4 } })).toEqual([{ op: "replace", path: "/mechanic/answeredCount", value: 4 }]);
  });

  it("fails cleanly on an invalid patch (client then resyncs)", () => {
    expect(applyPatch({ a: 1 }, [{ op: "replace", path: "/missing/x", value: 1 }]).ok).toBe(false);
    expect(applyPatch({ a: [] }, [{ op: "remove", path: "/a/0" }]).ok).toBe(false);
  });
});

describe("timing", () => {
  it("backoff stays within [0, cap] and grows with attempts", () => {
    fc.assert(fc.property(fc.nat(50), fc.double({ min: 0, max: 0.999999, noNaN: true }), (n, r) => {
      const d = backoffDelay(n, r);
      expect(d >= 0 && d <= 2000).toBe(true);
    }));
    expect(backoffDelay(0, 0.999)).toBeLessThan(100);
    expect(backoffDelay(10, 0.999)).toBeGreaterThan(1900);
  });

  it("estimates clock offset from the server pings and their measured round trip, preferring low RTT", () => {
    const est = new ClockEstimator();
    // True offset +500 ms: the server sends at server time S, the ping takes rtt/2, arrives at client S - 500 + rtt/2.
    est.add(pingSample(1500, 20, 1010)); // rtt 20 ms
    est.add(pingSample(2500, 10, 2005)); // rtt 10 ms
    est.add(pingSample(4500, 1800, 4700)); // congested Wi-Fi: held 1.2 s one way, 0.6 s back → offset 700: not trusted
    expect(est.offsetMs).toBeCloseTo(500, -1);
    expect(est.rttMs).toBe(20);
    // A first ping without measure counts, but never before a measured one.
    const first = new ClockEstimator();
    first.add(pingSample(1000, null, 500));
    expect(first.offsetMs).toBe(500);
  });

  it("detects view sequence gaps and duplicates", () => {
    expect(checkViewSeq(3, 4)).toBe("next");
    expect(checkViewSeq(3, 6)).toBe("gap");
    expect(checkViewSeq(3, 3)).toBe("duplicate");
  });
});

describe("patch safety (review)", () => {
  it("refuses prototype keys instead of silently diverging", () => {
    expect(applyPatch({ counts: {} }, [{ op: "add", path: "/counts/__proto__", value: 1 }])).toMatchObject({ ok: false });
    expect(applyPatch({ a: {} }, [{ op: "add", path: "/a/constructor", value: 1 }])).toMatchObject({ ok: false });
  });

  it("parses array indexes strictly (RFC 6901)", () => {
    for (const path of ["/a/", "/a/01", "/a/1.0", "/a/-1"]) {
      expect(applyPatch({ a: [1, 2] }, [{ op: "replace", path, value: 0 }]).ok).toBe(false);
    }
    expect(applyPatch({ a: [1, 2] }, [{ op: "add", path: "/a/-", value: 3 }])).toEqual({ ok: true, value: { a: [1, 2, 3] } });
  });
});
