import { describe, expect, it } from "vitest";
import { signToken, verifyToken, viewerOf, type TokenClaims } from "./tokens.ts";
import { ulid } from "./ids.ts";

const SECRET = "s".repeat(64);
const claims: TokenClaims = { v: 1, show: "main", jti: "out-program", exp: null, role: "output", scene: "program" };
const opts = { now: 1000, show: "main", isRevoked: () => false };

describe("role tokens", () => {
  it("verifies a token it signed and maps it to a viewer", () => {
    const r = verifyToken(SECRET, signToken(SECRET, claims), opts);
    expect(r).toEqual({ ok: true, claims });
    expect(r.ok && viewerOf(r.claims)).toEqual({ role: "output", scene: "program" });
  });

  it("is deterministic: links survive restarts", () => {
    expect(signToken(SECRET, claims)).toBe(signToken(SECRET, claims));
  });

  it("rejects a tampered payload (privilege escalation output → control)", () => {
    const [, sig] = signToken(SECRET, claims).split(".");
    const forged = `${Buffer.from(JSON.stringify({ ...claims, role: "control" })).toString("base64url")}.${sig ?? ""}`;
    expect(verifyToken(SECRET, forged, opts)).toEqual({ ok: false, error: "bad-signature" });
  });

  it("rejects another secret, another show, expiry and revocation", () => {
    const t = signToken(SECRET, claims);
    expect(verifyToken("x".repeat(64), t, opts)).toEqual({ ok: false, error: "bad-signature" });
    expect(verifyToken(SECRET, t, { ...opts, show: "other" })).toEqual({ ok: false, error: "wrong-show" });
    expect(verifyToken(SECRET, signToken(SECRET, { ...claims, exp: 500 }), opts)).toEqual({ ok: false, error: "expired" });
    expect(verifyToken(SECRET, t, { ...opts, isRevoked: (j) => j === "out-program" })).toEqual({ ok: false, error: "revoked" });
  });

  it.each(["", "abc", "a.b.c", "!!.!!"])("rejects malformed token %j", (t) => {
    expect(verifyToken(SECRET, t, opts).ok).toBe(false);
  });
});

describe("ulid", () => {
  it("is 26 chars of Crockford base32 and sorts by time", () => {
    const a = ulid(1000, new Uint8Array(10));
    const b = ulid(2000, new Uint8Array(10).fill(255));
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });
});
