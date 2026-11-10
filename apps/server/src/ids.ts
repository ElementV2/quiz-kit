import { randomBytes } from "node:crypto";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

/** ULID (ADR-0011): 48-bit ms timestamp + 80 random bits, lexicographically sortable. */
export function ulid(now: number = Date.now(), random: Uint8Array = randomBytes(10)): string {
  let t = Math.floor(now);
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = (B32[t % 32] ?? "0") + time;
    t = Math.floor(t / 32);
  }
  let bits = 0;
  let acc = 0;
  let rand = "";
  for (const byte of random) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      rand += B32[(acc >>> bits) & 31] ?? "0";
    }
  }
  return time + rand.slice(0, 16);
}

export const newId = (prefix: string): string => `${prefix}_${ulid()}`;
