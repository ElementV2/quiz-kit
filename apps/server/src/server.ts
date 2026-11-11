import { randomBytes, randomInt } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { defaultRegistry } from "@quiz/engine";
import { DEMO_GAME, TEMPLATES, loadGameDocument, type GameDocument, type Session } from "@quiz/schema";
import type { Config } from "./config.ts";
import { buildHttpApp, loggerOptions } from "./http/app.ts";
import { newId } from "./ids.ts";
import { buildLinks, lanAddresses, linksFile, type Links } from "./links.ts";
import { signToken } from "./tokens.ts";
import { MediaStore } from "./media/media-store.ts";
import { PreloadCache } from "./media/preload.ts";
import { GameLibrary } from "./media/library.ts";
import { realTimers, SessionRuntime, type Clock, type Timers } from "./runtime/session-runtime.ts";
import { Rehearsal } from "./rehearsal.ts";
import { startOscServer } from "./control/osc-server.ts";
import { ChatHub } from "./chat/chat-hub.ts";
import { VmixConfig, VmixDriver } from "./vmix/driver.ts";
import { StandbyMirror } from "./standby.ts";
import { buildId } from "./http/app.ts";

/** A standby must never start its own game: it would diverge from the primary it mirrors. */
export class StandbyError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("serveur de secours : lancer les parties sur le serveur principal (ou basculer d'abord)");
  }
}
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
  /** Replaces the live game by a new session (connected screens follow at once). */
  newSession(game: GameDocument): Session;
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
  // Built-in templates are seeded once into the library (editable copies; deleting one does not bring it back).
  const library = new GameLibrary(dataDir);
  // Each built-in template is offered once: new templates of a newer version appear, a deleted one never comes back.
  const firstSeed = store.getMeta("templates-seeded") === null;
  for (const t of TEMPLATES) {
    const key = `template-seeded:${t.id}`;
    if (store.getMeta(key) !== null) continue;
    // Data dirs seeded before per-template tracking: the original templates were offered already.
    const offeredBefore = !firstSeed && ["g_modele_qcm", "g_modele_paliers", "g_modele_sondage", "g_modele_buzzer"].includes(t.id);
    if (!offeredBefore && library.get(t.id) === null && !library.put(t.id, t.game).ok) continue; // retried next start
    store.setMeta(key, "1");
  }
  store.setMeta("templates-seeded", "1");
  const media = new MediaStore(dataDir, { ffmpeg: process.env["QUIZ_FFMPEG"] ?? "ffmpeg", ffprobe: process.env["QUIZ_FFPROBE"] ?? "ffprobe" });
  const preloads = new PreloadCache(media);

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
  /** Team code of the home page: from the config, else generated once and kept in the journal database. */
  // 8 characters without look-alikes (no 0/O, 1/I/L): ~1e12 combinations, read out loud easily.
  const STAFF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const freshStaffCode = (): string => Array.from({ length: 8 }, () => STAFF_ALPHABET[randomInt(0, STAFF_ALPHABET.length)] ?? "X").join("");
  const staffCodeOf = (): string => {
    if (config.staffCode !== undefined) return config.staffCode;
    const existing = store.getMeta("staff-code");
    if (existing !== null && /^[2-9A-HJKMNP-Z]{8}$/.test(existing)) return existing;
    const fresh = freshStaffCode();
    store.setMeta("staff-code", fresh);
    return fresh;
  };
  const rotateStaffCode = (): string => {
    const fresh = freshStaffCode();
    store.setMeta("staff-code", fresh);
    writeLinks();
    return fresh;
  };
  const makeLinks = (): Links => buildLinks({ secret, show: config.show, outputs: config.outputs, seats: config.seats, hosts, port, tlsPort: null, generation });
  let links = makeLinks();
  const writeLinks = (): void => writeFileSync(join(dataDir, "links.txt"), linksFile(links, staffCodeOf()), { mode: 0o600 });

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
  const joinCodeOf = (sid: string): string => {
    const key = `join-code:${sid}`;
    const existing = store.getMeta(key);
    if (existing !== null && /^\d{6}$/.test(existing)) return existing;
    const fresh = String(randomInt(0, 1_000_000)).padStart(6, "0");
    store.setMeta(key, fresh);
    return fresh;
  };
  const joinPlayer = (name: string): { ok: true; token: string; participantId: string } | { ok: false; error: string } => {
    const participantId = newId("p");
    const ack = getRuntime().submit({ type: "player.add", participantId, displayName: name, channel: "play" }, { role: "control", id: "join" }, null);
    if (!ack.ok) return { ok: false, error: ack.reason };
    return { ok: true, participantId, token: signToken(secret, { v: 1, show: config.show, jti: `player-${participantId}`, exp: null, role: "player", participantId }) };
  };

  const claimSeat = (seat: number, name: string): { ok: true; participantId: string } | { ok: false; error: string } => {
    const rt = getRuntime();
    if (rt.current.state.participants.some((p) => p.seat === seat)) return { ok: false, error: `le siège ${seat} est déjà pris` };
    const participantId = newId("p");
    const ack = rt.submit({ type: "player.add", participantId, displayName: name, seat, channel: "seat" }, { role: "control", id: `seat-${seat}` }, null);
    return ack.ok ? { ok: true, participantId } : { ok: false, error: ack.reason };
  };

  const rehearsal = new Rehearsal(opts.timers ?? realTimers);
  let mirror: StandbyMirror | null = null;
  const vmix = new VmixDriver();
  const vmixPath = join(dataDir, "vmix.json");
  const readVmix = (): VmixConfig | null => {
    try {
      const r = VmixConfig.safeParse(JSON.parse(readFileSync(vmixPath, "utf8")));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  };
  const chat = new ChatHub({ runtime: () => getRuntime(), timers: opts.timers ?? realTimers, clock, dataDir, twitchClientId: config.twitchClientId, youtubeApiKey: config.youtubeApiKey, log: { info: (o, m) => http.log.info(o, m), warn: (o, m) => http.log.warn(o, m) } }); // http is created below; only called later
  const deps = {
    runtime: getRuntime,
    links: () => links,
    joinCode: () => joinCodeOf(getRuntime().session.id),
    newSession: (game: GameDocument) => switchSession(game),
    media,
    library,
    join: joinPlayer,
    claimSeat,
    revoke,
    secret,
    show: config.show,
    isRevoked,
    clock,
    connections: () => transport?.connectionCount ?? 0,
    presence: () => transport?.presence() ?? { total: 0, byRole: {}, seats: [], players: [] },
    health: () => ({ sessionId: getRuntime().session.id, lastSeq: getRuntime().current.state.lastSeq, journal: { ...store.pragmas(), ...getRuntime().journalHealth } }),
    dataDir,
    rehearsal,
    chat,
    standby: {
      status: () => mirror?.status ?? null,
      promote: (force: boolean) => {
        if (mirror === null || mirror.status.mode !== "standby") return "ce serveur n'est pas un serveur de secours en attente";
        // Split brain guard (review 4 I3): the primary answered recently → it is probably still running the show.
        const seen = mirror.status.lastContactAt;
        if (!force && seen !== null && clock() - seen < 8000) return "le principal répond encore (il y a moins de 8 s) : vérifier qu'il est vraiment arrêté, ou forcer la bascule";
        if (!force && mirror.status.diverged !== null) return `ce secours ne suit plus le principal (${mirror.status.diverged}) : basculer dessus donnerait un état différent ; forcer seulement en connaissance de cause`;
        mirror.promote();
        vmix.attach(getRuntime(), readVmix()); // only the active server drives vMix (review 4 m1)
        http.log.warn({ sessionId: getRuntime().session.id, forced: force }, "BASCULE : ce serveur de secours prend le show");
        return null;
      },
    },
    vmix: {
      status: () => ({ ...vmix.status }),
      config: () => vmix.current,
      set: (c: VmixConfig | null) => {
        writeFileSync(vmixPath, JSON.stringify(c), { mode: 0o600 });
        vmix.attach(getRuntime(), c);
      },
    },
    staffCode: staffCodeOf,
    rotateStaffCode,
    registry: defaultRegistry,
  };
  const http = buildHttpApp(deps, { logger: loggerOptions(config.logLevel), bodyLimit: 4 * 1024 * 1024 });
  // 25 ms broadcast coalescing: a burst of 500 answers becomes a few broadcasts, invisible on screen (40 fps).
  runtime = new SessionRuntime(store, defaultRegistry, session, clock, opts.timers ?? realTimers, http.log, { broadcastIntervalMs: opts.broadcastIntervalMs ?? 25 });
  const firstRuntime = runtime;
  // A standby never drives vMix (the primary does); attached at promotion.
  if (config.standbyOf === undefined) vmix.attach(runtime, readVmix());
  transport = new WsTransport({ runtime: getRuntime, secret, show: config.show, isRevoked, clock, log: http.log, preload: (viewer) => preloads.for(viewer, getRuntime().session.game) });
  const runtimeOpts = { broadcastIntervalMs: opts.broadcastIntervalMs ?? 25 };

  /**
   * Starts a new game (imported questions, template…) without restarting anything: the old session stays in the
   * journal; every connected screen is re-welcomed on the new one — no link to paste again.
   */
  function switchSession(game: GameDocument): Session {
    if (mirror !== null && mirror.status.mode === "standby") throw new StandbyError();
    const next: Session = { schemaVersion: 1, id: newId("ses"), game, seed: randomInt(0, 0xffff_ffff), createdAt: clock() };
    store.createSession(next);
    openSession(next);
    return next;
  }
  /** Swaps the live session (new game, or the standby following its primary): every screen is re-welcomed. */
  function openSession(next: Session): void {
    const old = getRuntime();
    rehearsal.detach(); // bots belong to the old session
    runtime = new SessionRuntime(store, defaultRegistry, next, clock, opts.timers ?? realTimers, http.log, runtimeOpts);
    old.close();
    if (mirror === null || mirror.status.mode !== "standby") vmix.attach(getRuntime(), vmix.current);
    transport?.rewelcomeAll();
    http.log.info({ sessionId: next.id, title: next.game.title }, "nouvelle partie");
  }
  transport.attach(http.server);
  // Hot standby: mirror the primary's journal (manual promotion from this server's control room).
  if (config.standbyOf !== undefined && config.standbyToken === undefined) throw new Error("QUIZ_STANDBY_TOKEN requis avec QUIZ_STANDBY_OF (jeton régie du principal)");
  if (config.standbyOf !== undefined && config.standbyToken !== undefined) {
    mirror = new StandbyMirror({
      primary: config.standbyOf,
      token: config.standbyToken,
      intervalMs: 500,
      runtime: getRuntime,
      openSession,
      hasSession: (id) => store.getSession(id) !== null,
      createSession: (s) => store.createSession(s),
      media,
      clock,
      fetch,
      build: buildId(defaultRegistry),
    });
    mirror.start();
  }
  // OSC control (off unless configured): a busy port must not prevent the show from starting.
  const osc = config.oscPort === undefined ? null : await startOscServer({ port: config.oscPort, host: config.host, allow: config.oscAllow, runtime: getRuntime, log: http.log }).catch((err: unknown) => {
    http.log.error({ err: err instanceof Error ? err.message : String(err), port: config.oscPort }, "OSC non démarré (port occupé ?)");
    return null;
  });
  const tr0 = transport;
  const rt0 = firstRuntime;
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

  const tr = transport;
  return {
    get links() {
      return links;
    },
    get runtime() {
      return getRuntime();
    },
    newSession: switchSession,
    store,
    http,
    port,
    secret,
    dataDir,
    revoke,
    async close() {
      osc?.close();
      mirror?.close();
      chat.close();
      vmix.close();
      tr.close();
      getRuntime().close();
      await http.close();
      store.close();
    },
  };
}

