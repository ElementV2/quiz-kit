/**
 * Minimal OSC 1.0 codec (https://opensoundcontrol.stanford.edu/spec-1_0.html): big-endian, OSC-strings
 * NUL-terminated and padded to 4 bytes, type tag string starting with ",", bundles "#bundle" + timetag + sized
 * elements. Only the types a control surface sends are decoded (i, f, s, T, F, N, h, d); a message with an unknown
 * tag is discarded, as the spec asks. Never throws on hostile input: returns null.
 */

export type OscArg = number | string | boolean | null | bigint;
export type OscMessage = { readonly address: string; readonly args: readonly OscArg[] };

const pad4 = (n: number): number => (n + 3) & ~3;

function readString(buf: Buffer, at: number): { value: string; next: number } | null {
  const end = buf.indexOf(0, at);
  if (end < 0) return null;
  const next = pad4(end + 1);
  if (next > buf.length) return null;
  return { value: buf.toString("ascii", at, end), next };
}

function decodeMessage(buf: Buffer): OscMessage | null {
  const addr = readString(buf, 0);
  if (addr === null || !addr.value.startsWith("/")) return null;
  // Old implementations omit the type tag string: no arguments then.
  if (addr.next >= buf.length) return { address: addr.value, args: [] };
  const tags = readString(buf, addr.next);
  if (tags === null || !tags.value.startsWith(",")) return { address: addr.value, args: [] };
  let at = tags.next;
  const args: OscArg[] = [];
  for (const t of tags.value.slice(1)) {
    switch (t) {
      case "i":
        if (at + 4 > buf.length) return null;
        args.push(buf.readInt32BE(at));
        at += 4;
        break;
      case "f":
        if (at + 4 > buf.length) return null;
        args.push(buf.readFloatBE(at));
        at += 4;
        break;
      case "h":
        if (at + 8 > buf.length) return null;
        args.push(buf.readBigInt64BE(at));
        at += 8;
        break;
      case "d":
        if (at + 8 > buf.length) return null;
        args.push(buf.readDoubleBE(at));
        at += 8;
        break;
      case "s": {
        const s = readString(buf, at);
        if (s === null) return null;
        args.push(s.value);
        at = s.next;
        break;
      }
      case "T":
        args.push(true);
        break;
      case "F":
        args.push(false);
        break;
      case "N":
        args.push(null);
        break;
      default:
        return null; // unrecognised tag: discard the message (spec)
    }
  }
  return { address: addr.value, args };
}

/** Every message of a packet (a bundle is flattened; timetags are ignored: everything runs immediately). */
export function decodeOsc(buf: Buffer, depth = 0): OscMessage[] | null {
  if (buf.length < 4 || buf.length % 4 !== 0 || depth > 4) return null;
  if (buf[0] === 0x2f) {
    const m = decodeMessage(buf);
    return m === null ? null : [m];
  }
  if (buf.toString("ascii", 0, 8) !== "#bundle\0" || buf.length < 16) return null;
  const out: OscMessage[] = [];
  let at = 16; // "#bundle\0" + 8-byte timetag
  while (at < buf.length) {
    if (at + 4 > buf.length) return null;
    const size = buf.readInt32BE(at);
    at += 4;
    if (size <= 0 || size % 4 !== 0 || at + size > buf.length) return null;
    const inner = decodeOsc(buf.subarray(at, at + size), depth + 1);
    if (inner === null) return null;
    out.push(...inner);
    at += size;
  }
  return out;
}

function writeString(s: string): Buffer {
  const raw = Buffer.from(`${s}\0`, "ascii");
  const b = Buffer.alloc(pad4(raw.length));
  raw.copy(b);
  return b;
}

/** Encodes a message (ints, floats via `{ f }`, strings, booleans) — used by tests and the state feedback. */
export function encodeOsc(address: string, args: readonly (number | string | boolean | { readonly f: number })[] = []): Buffer {
  let tags = ",";
  const parts: Buffer[] = [];
  for (const a of args) {
    if (typeof a === "boolean") tags += a ? "T" : "F";
    else if (typeof a === "string") {
      tags += "s";
      parts.push(writeString(a));
    } else if (typeof a === "number") {
      tags += "i";
      const b = Buffer.alloc(4);
      b.writeInt32BE(Math.trunc(a));
      parts.push(b);
    } else {
      tags += "f";
      const b = Buffer.alloc(4);
      b.writeFloatBE(a.f);
      parts.push(b);
    }
  }
  return Buffer.concat([writeString(address), writeString(tags), ...parts]);
}
