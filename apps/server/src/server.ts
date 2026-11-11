import { randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { defaultRegistry } from "@quiz/engine";
import { DEMO_GAME, loadGameDocument, type GameDocument, type Session } from "@quiz/schema";
import type { Config } from "./config.ts";
import { buildHttpApp, loggerOptions } from "./http/app.ts";
import { newId } from "./ids.ts";
import { buildLinks, lanAddresses, linksFile, type Links } from "./links.ts";
import { signToken } from "./tokens.ts";
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
  readonly dataDir: string;
  /** Revokes one link (`control`, `out-program`, `seat-3`…): open connections are cut, a new link is issued. */
  revoke(link: string): Links;
  close(): Promise<void>;
};

function loadGame(path: string | undefined): GameDocument {
  if (path === undefined) return DEMO_GAME;
  const r = loadGameDocument(JSON.parse(readFileSync(path, "utf8")));
  if (!r.ok) throw new Error(`jeu invalide (${path}) : ${JSON.stringify(r.error)}`);
  return r.value;
}

/**
 * Token secret lives in its own file, NOT in the journal: the journal can be handed over for a dispute
 * without giving away the means to forge a control token. Migrates a secret stored by an older build.
 */
const SECRET_FORMAT = /^[0-9a-f]{64}$/;

function loadSecret(dataDir: string, store: SqliteEventStore): string {
  const file = join(dataDir, "secret.key");
  const legacy = store.getMeta("token-secret");
  if (existsSync(file)) {
    const secret = readFileSync(file, "utf8").trim();
    // An empty / truncated key would let anyone forge a control token: refuse to start instead.
    if (!SECRET_FORMAT.test(secret)) throw new Error(`secret.key invalide (${file}) : le supprimer pour en générer un nouveau (tous les liens changeront)`);
    if (legacy !== null) store.deleteMeta("token-secret"); // finish an interrupted migration
    return secret;
  }
  const secret = legacy !== null && SECRET_FORMAT.test(legacy) ? legacy : randomBytes(32).toString("hex");
  writeFileAtomic(file, `${secret}\n`);
  if (legacy !== null) store.deleteMeta("token-secret");
  return secret;
}

/** temp file + fsync + rename: a power cut leaves the old file or the complete new one, never a torn one. */
function writeFileAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

/** Composition root: wires store, runtime, transport and HTTP. Used by main.ts and integration tests. */
export async function startServer(config: Config, opts: { clock?: Clock; timers?: Timers; broadcastIntervalMs?: number } = {}): Promise<RunningServer> {
  const clock = opts.clock ?? Date.now;
  const dataDir = resolve(config.dataDir);
  mkdirSync(dataDir, { recursive: true });
  const store = new SqliteEventStore(join(dataDir, "journal.db"));
  try {
    return await boot(config, opts, clock, dataDir, store);
  } catch (e) {
    store.close(); // never leave the journal locked after a failed start (Windows keeps the file busy)
    throw e;
  }
}

async function boot(config: Config, opts: { timers?: Timers; broadcastIntervalMs?: number }, clock: Clock, dataDir: string, store: SqliteEventStore): Promise<RunningServer> {
  const secret = loadSecret(dataDir, store);

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
  const generation = (base: string): number => {
    const n = Number(store.getMeta(`token-gen:${base}`) ?? 0);
    return Number.isSafeInteger(n) && n >= 0 ? n : 0;
  };
  const hosts = [...lanAddresses(), "localhost", ...config.publicHosts];
  let port = config.port;
  // HTTPS for tablets arrives with ADR-0012 (phase 1). Outputs (OBS / vMix) work over plain HTTP from any PC.
  const makeLinks = (): Links => buildLinks({ secret, show: config.show, outputs: config.outputs, seats: config.seats, hosts, port, tlsPort: null, generation });
  let links = makeLinks();
  const writeLinks = (): void => writeFileSync(join(dataDir, "links.txt"), linksFile(links), { mode: 0o600 });

  const revoke = (base: string): Links => {
    const entry = links.entries.find((e) => e.id === base);
    if (entry === undefined) throw new Error(`lien inconnu : ${base}`);
    store.revokeAndBump(entry.jti, `token-gen:${base}`, String(generation(base) + 1)); // one transaction
    transport?.disconnectJti(entry.jti);
    links = makeLinks();
    writeLinks();
    return links;
  };

  // Join code for `/play` (doc 09 « création à l'arrivée ») : 6 digits per session, shown in the control room.
  const joinKey = `join-code:${session.id}`;
  let joinCode = store.getMeta(joinKey);
  if (joinCode === null || !/^\d{6}$/.test(joinCode)) {
    joinCode = String(randomInt(0, 1_000_000)).padStart(6, "0");
    store.setMeta(joinKey, joinCode);
  }
  const code = joinCode;
  const joinPlayer = (name: string): { ok: true; token: string; participantId: string } | { ok: false; error: string } => {
    const participantId = newId("p");
    const ack = getRuntime().submit({ type: "player.add", participantId, displayName: name, channel: "play" }, { role: "control", id: "join" }, null);
    if (!ack.ok) return { ok: false, error: ack.reason };
    return { ok: true, participantId, token: signToken(secret, { v: 1, show: config.show, jti: `player-${participantId}`, exp: null, role: "player", participantId }) };
  };

  const deps = {
    runtime: getRuntime,
    links: () => links,
    joinCode: () => code,
    join: joinPlayer,
    revoke,
    secret,
    show: config.show,
    isRevoked,
    clock,
    connections: () => transport?.connectionCount ?? 0,
    health: () => ({ sessionId: getRuntime().session.id, lastSeq: getRuntime().current.state.lastSeq, journal: { ...store.pragmas(), ...getRuntime().journalHealth } }),
    dataDir,
  };
  const http = buildHttpApp(deps, { logger: loggerOptions(config.logLevel), bodyLimit: 64 * 1024 });
  // 25 ms broadcast coalescing: a burst of 500 answers becomes a few broadcasts, invisible on screen (40 fps).
  runtime = new SessionRuntime(store, defaultRegistry, session, clock, opts.timers ?? realTimers, http.log, { broadcastIntervalMs: opts.broadcastIntervalMs ?? 25 });
  transport = new WsTransport({ runtime: getRuntime, secret, show: config.show, isRevoked, clock, log: http.log });
  transport.attach(http.server);
  const tr0 = transport;
  const rt0 = runtime;
  const abort = async (): Promise<void> => {
    tr0.close();
    rt0.close();
    await http.close();
  };
  // Large accept backlog: after a restart every tablet reconnects at the same instant (reconnect storm).
  try {
    await http.listen({ host: config.host, port: config.port, backlog: 4096 });
  } catch (e) {
    await abort(); // e.g. port already taken
    throw e;
  }
  const address = http.server.address();
  port = typeof address === "object" && address !== null ? address.port : config.port;
  links = makeLinks();
  writeLinks();

  const rt = runtime;
  const tr = transport;
  return {
    get links() {
      return links;
    },
    runtime: rt,
    store,
    http,
    port,
    secret,
    dataDir,
    revoke,
    async close() {
      tr.close();
      rt.close();
      await http.close();
      store.close();
    },
  };
}
