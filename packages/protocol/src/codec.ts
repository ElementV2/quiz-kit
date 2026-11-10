import { ClientMessage, MAX_MESSAGE_BYTES, MAX_SERVER_MESSAGE_BYTES, ServerMessage } from "./messages.ts";

export type DecodeError = { readonly code: "too-large" | "bad-message"; readonly message: string };
export type Decoded<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: DecodeError };

/** UTF-8 byte length without TextEncoder (keeps the package usable in k6). */
export function utf8Length(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function decode<T>(raw: string, max: number, schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } } }): Decoded<T> {
  // Cheap pre-check before measuring exactly: a UTF-16 unit is at most 3 UTF-8 bytes.
  if (raw.length > max || utf8Length(raw) > max) return { ok: false, error: { code: "too-large", message: `message > ${max} octets` } };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: { code: "bad-message", message: "JSON invalide" } };
  }
  const r = schema.safeParse(json);
  if (!r.success) {
    const first = r.error.issues[0];
    return { ok: false, error: { code: "bad-message", message: first === undefined ? "message invalide" : `${first.path.map(String).join(".")}: ${first.message}` } };
  }
  return { ok: true, value: r.data };
}

export const decodeClientMessage = (raw: string): Decoded<ClientMessage> => decode(raw, MAX_MESSAGE_BYTES, ClientMessage);
export const decodeServerMessage = (raw: string): Decoded<ServerMessage> => decode(raw, MAX_SERVER_MESSAGE_BYTES, ServerMessage);
export const encode = (m: ClientMessage | ServerMessage): string => JSON.stringify(m);
