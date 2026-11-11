import { createSocket, type Socket } from "node:dgram";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import { isCommand, runCommand } from "./commands.ts";
import { decodeOsc } from "./osc.ts";

/**
 * OSC over UDP (Companion "Generic: OSC", lighting desks, network buzzer boxes). Address = `/quiz/<command>`,
 * arguments as in the HTTP API (e.g. `/quiz/buzz ,i 3`, `/quiz/layer-take ,s banner`, `/quiz/judge ,i 1`).
 * UDP has no authentication: OFF unless `QUIZ_OSC_PORT` is set, and senders can be limited to `QUIZ_OSC_ALLOW`.
 */

export type OscLog = { warn(o: object, msg: string): void; info(o: object, msg: string): void };

export const OSC_PREFIX = "/quiz/";

/** Messages handled per packet / per sender and second (a hostile bundle must never stall the game loop). */
const MAX_PER_PACKET = 16;
const MAX_PER_SECOND = 30;
/** Not over OSC: unauthenticated, and a duplicated UDP packet would undo twice (review 3 I1). */
const OSC_FORBIDDEN = new Set(["undo"]);

export function startOscServer(opts: { port: number; host: string; allow: readonly string[]; runtime: () => SessionRuntime; log: OscLog }): Promise<Socket> {
  // UDP has no authentication: OSC only with an explicit list of sender IPs (review 3 B2).
  if (opts.allow.length === 0) return Promise.reject(new Error("QUIZ_OSC_ALLOW requis : liste des IP autorisées à piloter en OSC"));
  const socket = createSocket("udp4");
  const allowed = new Set(opts.allow);
  const rate = new Map<string, { second: number; count: number }>();
  socket.on("message", (buf, rinfo) => {
    if (!allowed.has(rinfo.address)) return; // silently ignored: not one of ours
    const second = Math.floor(Date.now() / 1000);
    const r = rate.get(rinfo.address);
    const cur = r === undefined || r.second !== second ? { second, count: 0 } : r;
    rate.set(rinfo.address, cur);
    const messages = decodeOsc(buf)?.slice(0, MAX_PER_PACKET) ?? null;
    if (messages === null) {
      opts.log.warn({ from: rinfo.address, bytes: buf.length }, "paquet OSC illisible ignoré");
      return;
    }
    for (const m of messages) {
      if (!m.address.startsWith(OSC_PREFIX)) continue;
      const cmd = m.address.slice(OSC_PREFIX.length);
      if (++cur.count > MAX_PER_SECOND) return;
      if (!isCommand(cmd) || OSC_FORBIDDEN.has(cmd)) {
        opts.log.warn({ from: rinfo.address, address: m.address }, "commande OSC inconnue");
        continue;
      }
      void runCommand(opts.runtime(), cmd, m.args, "osc").then((res) => {
        if (!res.ok) opts.log.info({ from: rinfo.address, command: cmd, code: res.code }, `OSC refusé : ${res.reason}`);
      });
    }
  });
  return new Promise((resolve, reject) => {
    socket.once("error", reject);
    socket.bind(opts.port, opts.host, () => {
      socket.off("error", reject);
      socket.on("error", (err) => opts.log.warn({ err: err.message }, "erreur OSC"));
      resolve(socket);
    });
  });
}
