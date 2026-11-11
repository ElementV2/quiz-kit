import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { assertNever } from "@quiz/engine";
import { ParticipantId, SceneName, type Viewer } from "@quiz/schema";

/**
 * Role tokens (doc 10): HMAC-SHA256 signed claims, per installation (`show`), revocable by `jti`.
 * Deterministic for a given (secret, claims): links pasted in OBS / vMix survive restarts.
 */
export const TokenClaims = z.discriminatedUnion("role", [
  z.strictObject({ v: z.literal(1), show: z.string(), jti: z.string(), exp: z.number().int().nullable(), role: z.literal("control") }),
  z.strictObject({ v: z.literal(1), show: z.string(), jti: z.string(), exp: z.number().int().nullable(), role: z.literal("control-readonly") }),
  z.strictObject({ v: z.literal(1), show: z.string(), jti: z.string(), exp: z.number().int().nullable(), role: z.literal("host") }),
  z.strictObject({ v: z.literal(1), show: z.string(), jti: z.string(), exp: z.number().int().nullable(), role: z.literal("studio") }),
  z.strictObject({ v: z.literal(1), show: z.string(), jti: z.string(), exp: z.number().int().nullable(), role: z.literal("output"), scene: SceneName }),
  z.strictObject({ v: z.literal(1), show: z.string(), jti: z.string(), exp: z.number().int().nullable(), role: z.literal("seat"), seat: z.number().int().min(1).max(999) }),
  z.strictObject({ v: z.literal(1), show: z.string(), jti: z.string(), exp: z.number().int().nullable(), role: z.literal("player"), participantId: ParticipantId }),
]);
export type TokenClaims = z.infer<typeof TokenClaims>;

export type TokenError = "malformed" | "bad-signature" | "expired" | "revoked" | "wrong-show";

const b64 = (s: string | Buffer): string => Buffer.from(s).toString("base64url");

function mac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function signToken(secret: string, claims: TokenClaims): string {
  const payload = b64(JSON.stringify(claims));
  return `${payload}.${mac(secret, payload).toString("base64url")}`;
}

export function verifyToken(
  secret: string,
  token: string,
  opts: { now: number; show: string; isRevoked: (jti: string) => boolean },
): { ok: true; claims: TokenClaims } | { ok: false; error: TokenError } {
  const [payload, sig, extra] = token.split(".");
  if (payload === undefined || sig === undefined || extra !== undefined) return { ok: false, error: "malformed" };
  const expected = mac(secret, payload);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, error: "bad-signature" };
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, error: "malformed" };
  }
  const parsed = TokenClaims.safeParse(raw);
  if (!parsed.success) return { ok: false, error: "malformed" };
  const c = parsed.data;
  if (c.show !== opts.show) return { ok: false, error: "wrong-show" };
  if (c.exp !== null && c.exp <= opts.now) return { ok: false, error: "expired" };
  if (opts.isRevoked(c.jti)) return { ok: false, error: "revoked" };
  return { ok: true, claims: c };
}

export function viewerOf(c: TokenClaims): Viewer {
  switch (c.role) {
    case "output":
      return { role: "output", scene: c.scene };
    case "seat":
      return { role: "seat", seat: c.seat };
    case "player":
      return { role: "player", participantId: c.participantId };
    case "control":
    case "control-readonly":
    case "host":
    case "studio":
      return { role: c.role };
    default:
      return assertNever(c);
  }
}
