import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { Readable } from "node:stream";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { Links } from "../links.ts";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import { loadGameDocument, type GameDocument, MIGRATIONS } from "@quiz/schema";
import type { MediaStore } from "../media/media-store.ts";
import { GameLibrary, exportQuiz, importQuiz } from "../media/library.ts";
import { verifyToken } from "../tokens.ts";
import { decide, participantTotal, type Registry, autoVerdicts } from "@quiz/engine";
import { AnswerSpec, QuestionId, cleanDisplayName } from "@quiz/schema";
import { buildResults, resultsCsv, resultsHtml } from "../results.ts";
import type { Rehearsal } from "../rehearsal.ts";
import type { ChatHub } from "../chat/chat-hub.ts";
import { VmixConfig } from "../vmix/driver.ts";
import { COMMANDS, isCommand, runCommand } from "../control/commands.ts";
import { nextStep, PROTOCOL_VERSION } from "@quiz/protocol";

export type HttpDeps = {
  readonly runtime: () => SessionRuntime;
  readonly links: () => Links;
  readonly revoke: (linkId: string) => Links;
  readonly joinCode: () => string;
  /** `keepPlayers` (default true): the current players come along to the new game (scores reset). */
  readonly newSession: (game: GameDocument, keepPlayers?: boolean) => { id: string; kept?: number; dropped?: number };
  /** Which library game the live session came from (« Envoyer au direct » only for that one). */
  readonly liveGameId: () => string | null;
  readonly setLiveGameId: (sessionId: string, gameId: string) => void;
  readonly media: MediaStore;
  readonly library: GameLibrary;
  readonly join: (name: string) => { ok: true; token: string; participantId: string } | { ok: false; error: string };
  /** A free seat tablet seats its player itself (name typed on the tablet). */
  readonly claimSeat: (seat: number, name: string) => { ok: true; participantId: string } | { ok: false; error: string };
  readonly secret: string;
  readonly show: string;
  readonly isRevoked: (jti: string) => boolean;
  readonly clock: () => number;
  readonly connections: () => number;
  readonly presence: () => Record<string, unknown>;
  readonly health: () => Record<string, unknown>;
  readonly dataDir: string;
  readonly rehearsal: Rehearsal;
  readonly chat: ChatHub;
  /** `promote` returns null on success, else why it was refused. */
  readonly standby: { status: () => object | null; promote: (force: boolean) => string | null };
  readonly vmix: { status: () => object; config: () => VmixConfig | null; set: (c: VmixConfig | null) => void };
  /** Team access code of the home page (`/`). */
  readonly staffCode: () => string;
  readonly rotateStaffCode: () => string;
  readonly registry: Registry;
};

/** Tokens live in URLs (OBS, QR codes): never let them reach the logs (doc 10). */
export const redactToken = (url: string | undefined): string => (url ?? "").replace(/([?&]t=)[^&#]+/g, "$1[redacted]");

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer", // the token is in the URL: never leak it through Referer
  // The control room may embed its own outputs (same origin only).
  "x-frame-options": "SAMEORIGIN",
  // Scripts: own files only. Styles: inline allowed (Solid style bindings / templates); all text is rendered as text.
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
};

/** Logger with token redaction. `stream` is for tests that inspect the log output. */
export function loggerOptions(level: string, stream?: { write(s: string): void }) {
  return {
    level,
    ...(stream === undefined ? {} : { stream }),
    serializers: {
      req: (req: { method?: string; url?: string }) => ({ method: req.method ?? "", url: redactToken(req.url) }),
    },
  };
}

/** Front apps built by Vite (`pnpm build`), served from their `dist`; an app not built says so (never a fake page). */
const APPS = ["output", "control", "host", "player", "studio", "hub"] as const;
type AppName = (typeof APPS)[number];
/** Built front-ends: `apps/<name>/dist` in the repo, or `QUIZ_APPS_DIR/<name>/dist` (desktop package). */
const APPS_ROOT = process.env["QUIZ_APPS_DIR"] ?? join(import.meta.dirname, "..", "..", "..");
const appDist = (name: AppName): string => join(APPS_ROOT, name, "dist");

function appIndex(name: AppName): string {
  const file = join(appDist(name), "index.html");
  return existsSync(file) ? readFileSync(file, "utf8") : notBuilt(name);
}

/** Shown instead of an app that was not built (dev checkout without `pnpm build`). */
const notBuilt = (name: AppName): string => `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quizzkit — app non installée</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}code{background:#222;padding:2px 6px;border-radius:4px}</style></head><body><main><h1>Cette app n'est pas installée</h1><p>L'app « ${name} » n'a pas été compilée sur ce serveur. Lancer <code>pnpm build</code>, puis recharger la page.</p></main></body></html>`;

const page = (name: AppName) => async (_req: unknown, reply: { header(k: string, v: string): unknown; type(t: string): { send(b: string): unknown } }) => {
  reply.header("cache-control", "no-cache"); // the HTML is tiny; assets are hashed and cached for a year
  return reply.type("text/html; charset=utf-8").send(appIndex(name));
};

function roleOf(deps: HttpDeps, req: FastifyRequest<{ Querystring: { t?: string } }>): string | null {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const token = req.query.t ?? bearer ?? "";
  const r = verifyToken(deps.secret, token, { now: deps.clock(), show: deps.show, isRevoked: deps.isRevoked });
  return r.ok ? r.claims.role : null;
}
const controlToken = (deps: HttpDeps, req: FastifyRequest<{ Querystring: { t?: string } }>): boolean => roleOf(deps, req) === "control";
/** Content editing (library, media): control room or studio. */
const staffToken = (deps: HttpDeps, req: FastifyRequest<{ Querystring: { t?: string } }>): boolean => {
  const r = roleOf(deps, req);
  return r === "control" || r === "studio";
};

/** Scores and results: control room. */
const scoreToken = (deps: HttpDeps, req: FastifyRequest<{ Querystring: { t?: string } }>): boolean => roleOf(deps, req) === "control";

const RegradeBody = z.strictObject({ questionId: QuestionId, answerSpec: AnswerSpec });
const RehearsalBody = z.strictObject({
  /** Also run with real players present (explicit: a rehearsal must never pollute a show by mistake). */
  withPlayers: z.boolean().default(false),
  bots: z.number().int().min(1).max(500),
  accuracy: z.number().min(0).max(1).default(0.6),
  latencyMs: z.number().int().min(0).max(60_000).default(3000),
});

/** The server PC itself (no proxy in front: the socket address is the peer). */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const StaffBody = z.strictObject({ code: z.string().max(20).optional() });

const RevokeBody = z.strictObject({ link: z.string().regex(/^[0-9a-z-]+$/).max(64) });
const JoinBody = z.strictObject({ code: z.string().regex(/^\d{6}$/), name: z.string().trim().min(1).max(40) });

/** Constant-time comparison of two short strings (team code). */
function timingSafeEqualStr(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** What must be identical on a primary and its standby: protocol version + registered mechanics. */
export const buildId = (registry: Registry): string => `p${PROTOCOL_VERSION}:${registry.ids().join(",")}`;

/** Events per `/api/journal` page. */
const JOURNAL_PAGE = 2000;

/** Join attempts per IP and minute (a wrong code must not be brute-forced). */
const JOIN_LIMIT = 10;

export function buildHttpApp(deps: HttpDeps, options: FastifyServerOptions): FastifyInstance {
  const app = Fastify(options);
  // No CORS headers at all: cross-origin reads stay blocked by browsers (doc 10).
  app.addHook("onSend", async (_req, reply, payload) => {
    // Defaults only: a route may set a stricter policy (`/media`: sandbox CSP) that must survive this hook.
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!reply.hasHeader(k)) reply.header(k, v);
    return payload;
  });
  // Fastify's default 404 handler logs the raw URL (token included): replace it, log nothing.
  app.setNotFoundHandler(async (_req, reply) => reply.code(404).type("text/plain; charset=utf-8").send("introuvable\n"));
  app.setErrorHandler(async (err: unknown, req, reply) => {
    const status = typeof err === "object" && err !== null && "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    const message = err instanceof Error ? err.message : "erreur";
    req.log.error({ err: { message, status }, url: redactToken(req.url) }, "erreur HTTP");
    return reply.code(status).send({ error: status < 500 ? message : "erreur serveur" });
  });

  /** Public liveness only; details need the control token. */
  app.get<{ Querystring: { t?: string } }>("/health", async (req) => (controlToken(deps, req) ? { ok: true, ...deps.health(), clients: deps.connections() } : { ok: true }));

  /** Every link (with tokens) + the join code, for the control room — requires the control token. */
  app.get<{ Querystring: { t?: string } }>("/api/links", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return { ...deps.links(), joinCode: deps.joinCode(), title: deps.runtime().current.state.game.title };
  });

  /** Look of the current game (theme + scenes): public data, any valid role token. Outputs refetch it on a game switch. */
  app.get<{ Querystring: { t?: string } }>("/api/presentation", async (req, reply) => {
    const r = verifyToken(deps.secret, req.query.t ?? "", { now: deps.clock(), show: deps.show, isRevoked: deps.isRevoked });
    if (!r.ok) return reply.code(401).send({ error: "jeton requis" });
    const rt = deps.runtime();
    const game = rt.current.state.game; // live edits (game.patch) included
    return { sessionId: rt.session.id, gameVersion: rt.current.state.gameVersion, theme: game.theme ?? null, scenes: game.scenes };
  });

  /** Live status for the control room: presence + journal health (polled every few seconds). */
  app.get<{ Querystring: { t?: string } }>("/api/status", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return { ...deps.health(), presence: deps.presence() };
  });

  // Media upload: raw body streamed to disk while hashed (no multipart, no buffering of big stingers).
  app.addContentTypeParser(/^(image|video|audio)\/.+$|^application\/octet-stream$/, (_req, payload, done) => done(null, payload));
  app.post<{ Querystring: { t?: string; name?: string } }>("/api/media", { bodyLimit: 1024 * 1024 * 1024 }, async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    const mime = (req.headers["content-type"] ?? "application/octet-stream").split(";")[0]?.trim() ?? "application/octet-stream";
    const body = req.body;
    if (typeof body !== "object" || body === null || !("pipe" in body)) return reply.code(400).send({ error: "corps binaire attendu" });
    try {
      const meta = await deps.media.put(body as Readable, mime, req.query.name ?? "media"); // oxlint-disable-line typescript/no-unsafe-type-assertion -- the content-type parser above hands over the raw request stream
      return { media: deps.media.asMedia(meta), name: meta.name, size: meta.size, convertedFrom: meta.convertedFrom ?? null };
    } catch (e) {
      return reply.code(415).send({ error: e instanceof Error ? e.message : "média refusé" });
    }
  });

  /** Media by content hash: immutable bytes → cached a year; SVG / HTML can never run script (sandbox CSP). */
  app.get<{ Params: { hash: string } }>("/media/:hash", async (req, reply) => {
    const meta = deps.media.meta(req.params.hash);
    const path = deps.media.pathOf(req.params.hash);
    if (meta === null || path === null) return reply.code(404).send({ error: "média inconnu" });
    reply.header("cache-control", "public, max-age=31536000");
    reply.header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    // An SVG opened directly is a document: never render it inline (still fine for <img>, CSS url() and fetch).
    if (meta.mime === "image/svg+xml") reply.header("content-disposition", "attachment");
    reply.type(meta.mime);
    // Files are stored by hash, without extension: `send` would replace our type with application/octet-stream
    // (an SVG logo then never decodes) and our cache header with its own. Both options: @fastify/static SendOptions.
    return reply.sendFile(req.params.hash, deps.media.dir, { contentType: false, cacheControl: false });
  });

  // ── Game library (studio) ──────────────────────────────────────────────────
  app.get<{ Querystring: { t?: string } }>("/api/games", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    return { games: deps.library.list() };
  });
  app.get<{ Querystring: { t?: string }; Params: { id: string } }>("/api/games/:id", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    const g = deps.library.get(req.params.id);
    return g === null ? reply.code(404).send({ error: "partie inconnue" }) : { game: g };
  });
  app.put<{ Querystring: { t?: string }; Params: { id: string } }>("/api/games/:id", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    const body = z.strictObject({ game: z.unknown() }).safeParse(req.body);
    const r = deps.library.put(req.params.id, body.success ? body.data.game : null);
    return r.ok ? { ok: true } : reply.code(400).send({ error: "jeu invalide", detail: r.error });
  });
  app.delete<{ Querystring: { t?: string }; Params: { id: string } }>("/api/games/:id", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    return deps.library.delete(req.params.id) ? { ok: true } : reply.code(404).send({ error: "partie inconnue" });
  });
  /** Launches a library game live (control room only). */
  // Control room or studio (« Lancer en direct » on the game being edited): every screen switches, journaled.
  app.post<{ Querystring: { t?: string; players?: string }; Params: { id: string } }>("/api/games/:id/launch", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    // From the studio only while nothing is played (lobby, no player): a show in progress is switched by the control room.
    const live = deps.runtime().current.state;
    if (roleOf(deps, req) === "studio" && (live.phase !== "lobby" || live.participants.length > 0)) {
      return reply.code(409).send({ error: `« ${live.game.title} » est en cours (${live.participants.length} joueur(s)) : changer de partie depuis la régie (onglet Parties)` });
    }
    const g = deps.library.get(req.params.id);
    if (g === null) return reply.code(404).send({ error: "partie inconnue" });
    const s = deps.newSession(g, req.query.players !== "new");
    deps.setLiveGameId(s.id, req.params.id);
    return { sessionId: s.id, title: g.title, joinCode: deps.joinCode(), kept: s.kept ?? 0, dropped: s.dropped ?? 0 };
  });
  /** `.quiz` export: game + its media in one zip, to move a game to the show machine. */
  app.get<{ Querystring: { t?: string }; Params: { id: string } }>("/api/games/:id/export", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    const g = deps.library.get(req.params.id);
    if (g === null) return reply.code(404).send({ error: "partie inconnue" });
    reply.header("content-disposition", `attachment; filename="${req.params.id}.quiz"`);
    return reply.type("application/zip").send(Buffer.from(exportQuiz(g, deps.media)));
  });
  app.addContentTypeParser("application/zip", { parseAs: "buffer", bodyLimit: 2 * 1024 * 1024 * 1024 }, (_req, body, done) => done(null, body));
  app.post<{ Querystring: { t?: string; id?: string } }>("/api/import", { bodyLimit: 2 * 1024 * 1024 * 1024 }, async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    if (!(req.body instanceof Buffer)) return reply.code(400).send({ error: "archive .quiz attendue (application/zip)" });
    const r = await importQuiz(new Uint8Array(req.body), deps.media);
    if (!r.ok) return reply.code(400).send({ error: r.error });
    const id = req.query.id !== undefined && GameLibrary.isId(req.query.id) ? req.query.id : `g_${Date.now().toString(36)}`;
    const saved = deps.library.put(id, r.game);
    return saved.ok ? { id, title: r.game.title, media: r.media, missing: r.missing } : reply.code(400).send({ error: "jeu invalide" });
  });

  /**
   * After the show (doc 09): `kind=ranking|detail`, `format=csv` (Excel, `;`) or `html` (printable → PDF).
   * Answers of every player: control room only.
   */
  app.get<{ Querystring: { t?: string; kind?: string; format?: string } }>("/api/results", async (req, reply) => {
    if (!scoreToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const r = buildResults(deps.runtime().current, deps.registry);
    const stamp = new Date(deps.clock()).toISOString().slice(0, 16).replace("T", " ");
    if (req.query.format === "html") return reply.type("text/html; charset=utf-8").header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'").send(resultsHtml(r, stamp));
    const kind = req.query.kind === "detail" ? "detail" : "ranking";
    reply.header("content-disposition", `attachment; filename="resultats-${kind}.csv"`);
    return reply.type("text/csv; charset=utf-8").send(resultsCsv(r, kind));
  });

  /** Regrade preview (doc 09 « aperçu avant validation »): totals before / after, nothing journaled. */
  app.post<{ Querystring: { t?: string } }>("/api/regrade/preview", async (req, reply) => {
    if (!scoreToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const body = RegradeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "question et réponse attendues" });
    const game = deps.runtime().current;
    const r = decide(game, { action: { type: "question.regrade", ...body.data }, actor: { role: "control", id: "preview" }, idempotencyKey: null }, deps.clock(), deps.registry);
    if (!r.ok) return reply.code(409).send({ error: r.error.message, code: r.error.code });
    const after = r.value.game.state;
    const changes = game.state.participants
      .map((p) => ({ participantId: p.id, name: p.displayName, before: participantTotal(game.state, p.id), after: participantTotal(after, p.id) }))
      .filter((c) => c.before !== c.after);
    return { changes };
  });

  /**
   * Answers given to a question already revealed (« Corriger » in the run-down): each player's answer, the automatic
   * verdict and the one forced by the control room, plus the mechanic view to show the answers in words.
   */
  app.get<{ Querystring: { t?: string; round?: string; question?: string } }>("/api/question-answers", async (req, reply) => {
    if (!scoreToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const q = z.strictObject({ t: z.string().optional(), round: z.coerce.number().int().min(0), question: z.coerce.number().int().min(0) }).safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "manche et question attendues" });
    const ri = q.data.round;
    const qi = q.data.question;
    const st = deps.runtime().current.state;
    const h = st.history.find((x) => x.roundIndex === ri && x.questionIndex === qi);
    if (h === undefined) return reply.code(404).send({ error: "question pas encore révélée" });
    const m = deps.registry.get(h.mechanicId);
    if (m === null) return reply.code(404).send({ error: "type de manche inconnu" });
    const auto = autoVerdicts(m.judge(h.state));
    const given = m.answers(h.state);
    const ids = [...new Set([...given.map((a) => a.participantId), ...auto.keys(), ...h.verdicts.map((v) => v.participantId)])];
    const names = new Map(st.participants.map((p) => [p.id, p.displayName]));
    const byPid = new Map(given.map((a) => [a.participantId, a.optionIds]));
    const forced = new Map(h.verdicts.map((v) => [v.participantId, v.correct]));
    return {
      mechanic: m.project(h.state, { audience: "control", phase: "revealed", participantId: null }),
      rows: ids.map((pid) => ({ participantId: pid, name: names.get(pid) ?? "joueur retiré", optionIds: [...(byPid.get(pid) ?? [])], auto: auto.get(pid) ?? null, forced: forced.get(pid) ?? null })),
    };
  });

  /** Rehearsal mode (doc 07): bots that answer like tablets. Control only; never during a real show. */
  app.get<{ Querystring: { t?: string } }>("/api/rehearsal", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return deps.rehearsal.status;
  });
  app.post<{ Querystring: { t?: string } }>("/api/rehearsal", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const body = RehearsalBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "bots (1 à 500), accuracy (0 à 1), latencyMs attendus" });
    const { withPlayers, ...settings } = body.data;
    const r = await deps.rehearsal.start(deps.runtime(), settings, withPlayers);
    return r.ok ? { bots: r.bots, refused: r.refused } : reply.code(409).send({ error: r.error });
  });
  app.delete<{ Querystring: { t?: string } }>("/api/rehearsal", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return { removed: await deps.rehearsal.stop() };
  });

  /**
   * Session + journal, for the replay viewer of the studio (doc 09 « replay depuis le journal »), by pages
   * (`from` = first seq, at most 2000 events): a show-long journal is never serialised in one go mid-show.
   */
  app.get<{ Querystring: { t?: string; from?: string } }>("/api/journal", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    const g = deps.runtime().current;
    const from = Math.max(1, Number.parseInt(req.query.from ?? "1", 10) || 1);
    const events = g.events.filter((e) => e.seq >= from).slice(0, JOURNAL_PAGE);
    const last = events.at(-1);
    const lastSeq = g.events.at(-1)?.seq ?? 0;
    // `build`: a standby refuses to follow a primary whose engine judges differently (review 4 I2).
    return { session: g.session, events, lastSeq, next: last !== undefined && last.seq < lastSeq ? last.seq + 1 : null, build: buildId(deps.registry) };
  });

  /**
   * External control API (doc 08), for Bitfocus Companion "Generic: HTTP Requests", Stream Deck, scripts:
   * `POST /api/v1/<command>` with the control token (`Authorization: Bearer <token>` or `?t=`), optional
   * arguments `{ "args": [...] }` or `?arg=`. A refused intent still answers 200 `{ ok: false, reason }`
   * (Companion flags a connection in error on any non-2xx); 401 = bad token, 404 = unknown command.
   */
  app.post<{ Querystring: { t?: string; arg?: string }; Params: { command: string } }>("/api/v1/:command", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ ok: false, reason: "jeton régie requis" });
    const cmd = req.params.command;
    if (!isCommand(cmd)) return reply.code(404).send({ ok: false, reason: `commande inconnue (${COMMANDS.join(", ")})` });
    const body = z.strictObject({ args: z.array(z.union([z.string().max(64), z.number(), z.boolean()])).max(4).optional() }).safeParse(req.body ?? {});
    const args = body.success && body.data.args !== undefined ? body.data.args : req.query.arg === undefined ? [] : [req.query.arg];
    const idem = req.headers["idempotency-key"];
    const key = typeof idem === "string" && /^[0-9A-Za-z_-]{8,64}$/.test(idem) ? `api-${idem}` : null;
    return runCommand(deps.runtime(), cmd, args, "api", deps.clock(), key);
  });
  /** Chat connectors (Twitch / YouTube) for crowd-vote rounds: status, Twitch device login, start / stop. */
  app.get<{ Querystring: { t?: string } }>("/api/chat", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return deps.chat.status();
  });
  app.post<{ Querystring: { t?: string }; Params: { platform: string; op: string } }>("/api/chat/:platform/:op", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const { platform, op } = req.params;
    const body = z.strictObject({ channel: z.string().regex(/^[0-9A-Za-z_]{3,25}$/).optional(), videoId: z.string().regex(/^[0-9A-Za-z_-]{6,20}$/).optional() }).safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "chaîne Twitch ou identifiant de vidéo YouTube invalide" });
    try {
      if (platform === "twitch") {
        const tw = deps.chat.twitch;
        if (tw === null) return reply.code(409).send({ error: "Twitch non configuré (QUIZ_TWITCH_CLIENT_ID)" });
        if (op === "login") return await tw.startLogin();
        if (op === "start" && body.data.channel !== undefined) {
          await tw.start(body.data.channel);
          return deps.chat.status();
        }
        if (op === "stop") {
          tw.stop();
          return deps.chat.status();
        }
      }
      if (platform === "youtube") {
        const yt = deps.chat.youtube;
        if (yt === null) return reply.code(409).send({ error: "YouTube non configuré (QUIZ_YOUTUBE_API_KEY)" });
        if (op === "start" && body.data.videoId !== undefined) {
          await yt.start(body.data.videoId);
          return deps.chat.status();
        }
        if (op === "stop") {
          yt.stop();
          return deps.chat.status();
        }
      }
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : "erreur du service de chat" });
    }
    return reply.code(404).send({ error: "opération inconnue" });
  });

  /** Hot standby (doc 05): status on both servers; promotion of the standby by its control room. */
  app.get<{ Querystring: { t?: string } }>("/api/standby", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return { standby: deps.standby.status() };
  });
  app.post<{ Querystring: { t?: string } }>("/api/standby/promote", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const body = z.strictObject({ force: z.boolean().default(false) }).safeParse(req.body ?? {});
    const r = deps.standby.promote(body.success && body.data.force);
    if (r !== null) return reply.code(409).send({ error: r });
    return { standby: deps.standby.status() };
  });

  /** vMix titles driver (phase 5): config (field → binding) and status. Control only. */
  app.get<{ Querystring: { t?: string } }>("/api/vmix", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return { config: deps.vmix.config(), status: deps.vmix.status() };
  });
  app.put<{ Querystring: { t?: string } }>("/api/vmix", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const body = z.strictObject({ config: VmixConfig.nullable() }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `configuration vMix invalide : ${body.error.issues[0]?.message ?? ""}` });
    deps.vmix.set(body.data.config);
    return { config: deps.vmix.config(), status: deps.vmix.status() };
  });

  /** Small state for Companion variables / feedbacks (phase, question, timer, hand, top 3). */
  app.get<{ Querystring: { t?: string } }>("/api/v1/state", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ ok: false, reason: "jeton régie requis" });
    const v = deps.runtime().view({ role: "control" });
    if (v.role !== "control") return reply.code(500).send({ ok: false });
    const m = v.mechanic;
    const hand = m?.mechanic === "buzzer" || m?.mechanic === "board" ? m.hand : null;
    const name = (id: string | null) => (id === null ? null : (v.participants.find((p) => p.id === id)?.displayName ?? null));
    return {
      ok: true,
      phase: v.phase,
      round: v.round?.title ?? null,
      question: v.question === null ? null : { index: v.question.index + 1, count: v.question.count, text: v.question.prompt.text },
      timerRemainingMs: v.timer === null ? null : Math.max(0, v.timer.endsAt - deps.clock()),
      hand: name(hand),
      next: nextStep(v)?.label ?? null,
      hostDrives: v.hostDrives,
      top: v.leaderboard.slice(0, 3).map((r) => ({ rank: r.rank, name: r.displayName, total: r.total })),
    };
  });

  /** What is live: the library game it came from (null for a CSV / template quick game) and its title. */
  app.get<{ Querystring: { t?: string } }>("/api/live", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    const st = deps.runtime().current.state;
    return { gameId: deps.liveGameId(), title: st.game.title, phase: st.phase, players: st.participants.length, gameVersion: st.gameVersion };
  });

  /** The live document itself (with corrections made in the control room) and its version: what the studio edits. */
  app.get<{ Querystring: { t?: string } }>("/api/live/game", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    const st = deps.runtime().current.state;
    return { gameId: deps.liveGameId(), game: st.game, gameVersion: st.gameVersion };
  });

  /**
   * « Envoyer au direct » (studio): the edited game, if it is the live one, replaces the live document through the
   * journaled `game.patch` (refused when it would break what was played / what is on air). Saved to the library too.
   */
  app.post<{ Querystring: { t?: string }; Params: { id: string } }>("/api/games/:id/apply-live", async (req, reply) => {
    if (!staffToken(deps, req)) return reply.code(401).send({ error: "jeton régie ou studio requis" });
    if (deps.liveGameId() !== req.params.id) return reply.code(409).send({ error: "cette partie n'est pas celle en direct : la lancer d'abord (régie, onglet Parties)" });
    const body = z.strictObject({ game: z.unknown(), baseVersion: z.number().int().min(0) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "version de base manquante : recharger la partie en direct" });
    // Round types kept as sent: a session launched before keeps its rounds (a started round never changes type).
    const doc = loadGameDocument(body.data.game, MIGRATIONS, { upgradeRounds: false });
    if (!doc.ok) return reply.code(400).send({ error: "partie invalide : corriger les problèmes signalés dans le studio" });
    const ack = await new Promise<{ ok: true; seq: number } | { ok: false; reason: string }>((resolve) => {
      deps.runtime().enqueue({ type: "game.patch", game: doc.value, baseVersion: body.data.baseVersion }, { role: "control", id: "studio" }, null, (a) => resolve(a.ok ? { ok: true, seq: a.eventSeq } : { ok: false, reason: a.reason }));
    });
    if (!ack.ok) return reply.code(409).send({ error: ack.reason });
    // The version of THIS send (its seq), not the current one: a correction committed in the same batch is newer.
    const gameVersion = ack.seq;
    try {
      deps.library.put(req.params.id, doc.value);
    } catch {
      return { ok: true, gameVersion, warning: "appliqué au direct, mais pas enregistré dans la bibliothèque : enregistrer (Ctrl+S)" };
    }
    return { ok: true, gameVersion };
  });

  /** Starts a new game from a game document (imported CSV, template). Control token only; journaled. */
  app.post<{ Querystring: { t?: string } }>("/api/session", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const body = z.strictObject({ game: z.unknown(), keepPlayers: z.boolean().optional() }).safeParse(req.body);
    const r = loadGameDocument(body.success ? body.data.game : null);
    if (!r.ok) return reply.code(400).send({ error: "jeu invalide", detail: r.error });
    const s = deps.newSession(r.value, body.success ? body.data.keepPlayers : undefined);
    return { sessionId: s.id, title: r.value.title, joinCode: deps.joinCode(), kept: s.kept ?? 0, dropped: s.dropped ?? 0 };
  });

  const staffAttempts = new Map<string, { windowStart: number; count: number }>();
  /**
   * Home page unlock (doc 08): the team code (or being on the server PC itself) gives every link of the show,
   * so nobody has to copy long tokens around. Same brute-force guard as `/api/join`: per device (IP) only, never all
   * together, so a player trying codes on the Wi-Fi never locks the team out. 8+ letters/digits at 10 tries / min /
   * IP: guessing it is out of reach even from hundreds of addresses.
   */
  app.post("/api/staff", async (req, reply) => {
    // Behind a local proxy every client would look local: then the code is always required (review 3 m6).
    const proxied = req.headers["x-forwarded-for"] !== undefined || req.headers.forwarded !== undefined;
    const local = LOOPBACK.has(req.ip) && !proxied;
    const body = StaffBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "code attendu" });
    if (!local) {
      const now = deps.clock();
      if (staffAttempts.size > 10_000) staffAttempts.clear();
      const a = staffAttempts.get(req.ip);
      const attempt = a === undefined || now - a.windowStart > 60_000 ? { windowStart: now, count: 0 } : a;
      attempt.count += 1;
      staffAttempts.set(req.ip, attempt);
      if (attempt.count > JOIN_LIMIT) return reply.code(429).send({ error: "Trop d'essais : patienter une minute" });
      const given = (body.data.code ?? "").toUpperCase().replaceAll(/[\s-]/g, "");
      if (!timingSafeEqualStr(given, deps.staffCode())) {
        return reply.code(403).send({ error: "Code équipe incorrect" });
      }
      staffAttempts.delete(req.ip);
    }
    const links = deps.links();
    const live = deps.runtime().current.state;
    return {
      title: deps.runtime().current.state.game.title,
      players: live.participants.length,
      maxPlayers: live.game.format.participants.max,
      joinCode: deps.joinCode(),
      origins: links.origins,
      local,
      // Shown on the server PC only, so the operator can give it to the team.
      staffCode: local ? deps.staffCode() : null,
      entries: links.entries.map((e) => ({ label: e.label, id: e.id, role: e.role, path: e.path })),
    };
  });

  /** New team code (control token): to run before each show, or after it leaked. Old remembered codes stop working. */
  app.post<{ Querystring: { t?: string } }>("/api/staff/rotate", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return { staffCode: deps.rotateStaffCode() };
  });

  /**
   * Seat tablets (`/seat/<n>`): while nobody sits at the seat, the tablet itself seats its player by name — no code,
   * no wait for the control room (doc 09). The seat token proves which seat; a taken seat is refused (409).
   */
  app.post<{ Querystring: { t?: string } }>("/api/seat/claim", async (req, reply) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const r = verifyToken(deps.secret, req.query.t ?? bearer ?? "", { now: deps.clock(), show: deps.show, isRevoked: deps.isRevoked });
    if (!r.ok || r.claims.role !== "seat") return reply.code(401).send({ error: "lien de siège requis" });
    const body = z.strictObject({ name: z.string().trim().min(1).max(40) }).safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Prénom ou pseudo requis (40 caractères max.)" });
    const name = cleanDisplayName(body.data.name);
    if (name === "") return reply.code(400).send({ error: "Prénom ou pseudo requis (40 caractères max.)" });
    const res = deps.claimSeat(r.claims.seat, name);
    return res.ok ? { participantId: res.participantId } : reply.code(409).send({ error: res.error });
  });

  const joinAttempts = new Map<string, { windowStart: number; count: number }>();
  /** `/play`: a player joins with the code + a nickname, gets their own token (doc 09). */
  app.post("/api/join", async (req, reply) => {
    const now = deps.clock();
    const ip = req.ip;
    const a = joinAttempts.get(ip);
    const attempt = a === undefined || now - a.windowStart > 60_000 ? { windowStart: now, count: 0 } : a;
    attempt.count += 1;
    joinAttempts.set(ip, attempt);
    if (attempt.count > JOIN_LIMIT) return reply.code(429).send({ error: "Trop d'essais : patienter une minute" });
    const body = JoinBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Code à 6 chiffres et pseudo requis" });
    if (body.data.code !== deps.joinCode()) return reply.code(403).send({ error: "Code incorrect : recopier le code partie affiché à l'écran" });
    const name = cleanDisplayName(body.data.name);
    if (name === "") return reply.code(400).send({ error: "Pseudo requis" });
    const r = deps.join(name);
    if (!r.ok) return reply.code(409).send({ error: r.error });
    return { token: r.token, participantId: r.participantId };
  });

  /** Revokes one link: open connections using it are cut and a new link is issued (doc 10). */
  app.post<{ Querystring: { t?: string } }>("/api/revoke", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const body = RevokeBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "corps attendu : { link: \"seat-3\" }" });
    try {
      return deps.revoke(body.data.link);
    } catch {
      return reply.code(404).send({ error: "lien inconnu" });
    }
  });

  // The only decorating instance: gives `reply.sendFile` (ranges, etag) to the /media route.
  void app.register(fastifyStatic, { root: deps.media.dir, serve: false });
  for (const name of APPS) {
    if (!existsSync(appDist(name))) continue;
    // Hashed file names → long max-age (works over plain HTTP; `immutable` would be ignored there, ADR-0012).
    void app.register(fastifyStatic, { root: appDist(name), prefix: `/apps/${name}/`, decorateReply: false, index: false, maxAge: 31_536_000_000, immutable: false });
  }
  app.get("/control", page("control"));
  app.get("/host", page("host"));
  app.get("/out/:scene", page("output"));
  app.get("/seat/:n", page("player"));
  app.get("/play", page("player"));
  app.get("/studio", page("studio"));
  // Home page: players join with the code, the team unlocks every screen with the team code.
  app.get("/", page("hub"));
  return app;
}
