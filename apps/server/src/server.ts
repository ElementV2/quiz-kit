import { randomBytes, randomInt } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { defaultRegistry } from "@quiz/engine";
import { DEMO_GAME, loadGameDocument, type GameDocument, type Session } from "@quiz/schema";
import type { Config } from "./config.ts";
import { buildHttpApp, loggerOptions } from "./http/app.ts";
import { newId } from "./ids.ts";
import { buildLinks, lanAddresses, linksFile, type Links } from "./links.ts";
import { realTimers, SessionRuntime, type Clock, type Timers } from "./runtime/session-runtime.ts";
import { SqliteEventStore } from "./store/sqlite-event-store.ts";
import { WsTransport } from "./transport/ws-transport.ts";

export type RunningServer = {
  readonly links: Links;
  readonly runtime: SessionRuntime;
  readonly store: SqliteEventStore;
  readonly http: FastifyInstance;
  readonly port: number;
  readonly secret: string;
  close(): Promise<void>;
};

function loadGame(path: string | undefined): GameDocument {
  if (path === undefined) return DEMO_GAME;
  const r = loadGameDocument(JSON.parse(readFileSync(path, "utf8")));
  if (!r.ok) throw new Error(`jeu invalide (${path}) : ${JSON.stringify(r.error)}`);
  return r.value;
}

/** Composition root: wires store, runtime, transport and HTTP. Used by main.ts and integration tests. */
export async function startServer(config: Config, opts: { clock?: Clock; timers?: Timers } = {}): Promise<RunningServer> {
  const clock = opts.clock ?? Date.now;
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const store = new SqliteEventStore(join(dataDir, "journal.db"));

  let secret = store.getMeta("token-secret");
  if (secret === null) {
    secret = randomBytes(32).toString("hex");
    store.setMeta("token-secret", secret);
  }

  let sessionId = config.newSession ? null : store.latestSessionId();
  if (sessionId === null) {
    const session: Session = { schemaVersion: 1, id: newId("ses"), game: loadGame(config.game), seed: randomInt(0, 0xffff_ffff), createdAt: clock() };
    store.createSession(session);
    sessionId = session.id;
  }
  const session = store.getSession(sessionId);
  if (session === null) throw new Error(`session introuvable : ${sessionId}`);

  let runtime: SessionRuntime | null = null;
  let transport: WsTransport | null = null;
  const getRuntime = (): SessionRuntime => {
    if (runtime === null) throw new Error("runtime pas prêt");
    return runtime;
  };
  const isRevoked = (jti: string): boolean => store.isRevoked(jti);
  const hosts = [...lanAddresses(), "localhost", ...config.publicHosts];
  // HTTPS for tablets arrives with ADR-0012 (phase 1). Outputs (OBS / vMix) work over plain HTTP from any PC.
  let links = buildLinks({ secret, show: config.show, outputs: config.outputs, seats: config.seats, hosts, port: config.port, tlsPort: null });

  const deps = {
    runtime: getRuntime,
    links: () => links,
    secret,
    show: config.show,
    isRevoked,
    clock,
    connections: () => transport?.connectionCount ?? 0,
    health: () => ({ sessionId: getRuntime().session.id, lastSeq: getRuntime().current.state.lastSeq, journal: store.pragmas() }),
  };
  const http = buildHttpApp(deps, { logger: loggerOptions(config.logLevel), bodyLimit: 1024 * 1024 });
  runtime = new SessionRuntime(store, defaultRegistry, session, clock, opts.timers ?? realTimers, http.log);
  transport = new WsTransport({ runtime: getRuntime, secret, show: config.show, isRevoked, clock, log: http.log });
  transport.attach(http.server);
  await http.listen({ host: config.host, port: config.port });
  const address = http.server.address();
  const port = typeof address === "object" && address !== null ? address.port : config.port;
  if (port !== config.port) links = buildLinks({ secret, show: config.show, outputs: config.outputs, seats: config.seats, hosts, port, tlsPort: null });
  writeFileSync(join(dataDir, "links.txt"), linksFile(links));

  const rt = runtime;
  const tr = transport;
  return {
    links,
    runtime: rt,
    store,
    http,
    port,
    secret,
    async close() {
      tr.close();
      rt.close();
      await http.close();
      store.close();
    },
  };
}
