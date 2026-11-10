import { z } from "zod";
import { Action, View, Viewer } from "@quiz/schema";

export { PROTOCOL_VERSION } from "./version.ts";
/** Max size of one WebSocket message, both directions (doc 04). */
export const MAX_MESSAGE_BYTES = 16 * 1024;
/** Max size of a server message carrying a full view (snapshots can be larger than intents). */
export const MAX_SERVER_MESSAGE_BYTES = 1024 * 1024;

export const IdempotencyKey = z.string().min(8).max(64).regex(/^[0-9A-Za-z_-]+$/);

/** RFC 6902 subset (ADR-0009). Paths are RFC 6901 JSON Pointers. */
export const PatchOp = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.strictObject({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.strictObject({ op: z.literal("remove"), path: z.string() }),
]);
export type PatchOp = z.infer<typeof PatchOp>;

// ── client → server ──────────────────────────────────────────────────────────
export const Hello = z.strictObject({
  t: z.literal("hello"),
  v: z.number().int(),
  token: z.string().min(1).max(2048),
  clientId: z.string().min(1).max(64).regex(/^[0-9A-Za-z_-]+$/),
});
export const Intent = z.strictObject({ t: z.literal("intent"), key: IdempotencyKey, action: Action });
export const Pong = z.strictObject({ t: z.literal("pong"), clientTime: z.number(), serverTime: z.number() });
export const Resync = z.strictObject({ t: z.literal("resync") });

export const ClientMessage = z.discriminatedUnion("t", [Hello, Intent, Pong, Resync]);
export type ClientMessage = z.infer<typeof ClientMessage>;

// ── server → client ──────────────────────────────────────────────────────────
export const Welcome = z.strictObject({
  t: z.literal("welcome"),
  v: z.number().int(),
  viewer: Viewer,
  serverTime: z.number(),
  viewSeq: z.number().int().min(0),
  view: View,
});
export const Patch = z.strictObject({ t: z.literal("patch"), viewSeq: z.number().int().min(1), ops: z.array(PatchOp) });
export const Snapshot = z.strictObject({ t: z.literal("snapshot"), viewSeq: z.number().int().min(0), view: View });
export const Ack = z.discriminatedUnion("ok", [
  z.strictObject({ t: z.literal("ack"), key: IdempotencyKey, ok: z.literal(true), eventSeq: z.number().int().min(1) }),
  z.strictObject({ t: z.literal("ack"), key: IdempotencyKey, ok: z.literal(false), code: z.string(), reason: z.string() }),
]);
export const Ping = z.strictObject({ t: z.literal("ping"), serverTime: z.number() });
export const Preload = z.strictObject({ t: z.literal("preload"), hashes: z.array(z.string()) });
export const ErrorMessage = z.strictObject({
  t: z.literal("error"),
  code: z.enum(["bad-message", "too-large", "unsupported-version", "unauthorized", "rate-limited", "not-ready", "server-error"]),
  message: z.string(),
});

export const ServerMessage = z.union([Welcome, Patch, Snapshot, Ack, Ping, Preload, ErrorMessage]);
export type ServerMessage = z.infer<typeof ServerMessage>;
export type AckMessage = z.infer<typeof Ack>;
export type ErrorCode = z.infer<typeof ErrorMessage>["code"];
