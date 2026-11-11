import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { Links } from "../links.ts";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import { loadGameDocument, type GameDocument } from "@quiz/schema";
import { verifyToken } from "../tokens.ts";
import { PREVIEW_CSS, PREVIEW_HTML, PREVIEW_JS } from "./preview-page.ts";

export type HttpDeps = {
  readonly runtime: () => SessionRuntime;
  readonly links: () => Links;
  readonly revoke: (linkId: string) => Links;
  readonly joinCode: () => string;
  readonly newSession: (game: GameDocument) => { id: string };
  readonly join: (name: string) => { ok: true; token: string; participantId: string } | { ok: false; error: string };
  readonly secret: string;
  readonly show: string;
  readonly isRevoked: (jti: string) => boolean;
  readonly clock: () => number;
  readonly connections: () => number;
  readonly presence: () => Record<string, unknown>;
  readonly health: () => Record<string, unknown>;
  readonly dataDir: string;
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

/** Front apps built by Vite (`pnpm build`), served from their `dist`. Falls back to the phase-0 preview if not built. */
const APPS = ["output", "control", "host", "player"] as const;
type AppName = (typeof APPS)[number];
const appDist = (name: AppName): string => join(import.meta.dirname, "..", "..", "..", name, "dist");

function appIndex(name: AppName): string {
  const file = join(appDist(name), "index.html");
  return existsSync(file) ? readFileSync(file, "utf8") : PREVIEW_HTML;
}

const page = (name: AppName) => async (_req: unknown, reply: { header(k: string, v: string): unknown; type(t: string): { send(b: string): unknown } }) => {
  reply.header("cache-control", "no-cache"); // the HTML is tiny; assets are hashed and cached for a year
  return reply.type("text/html; charset=utf-8").send(appIndex(name));
};

function controlToken(deps: HttpDeps, req: FastifyRequest<{ Querystring: { t?: string } }>): boolean {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const token = req.query.t ?? bearer ?? "";
  const r = verifyToken(deps.secret, token, { now: deps.clock(), show: deps.show, isRevoked: deps.isRevoked });
  return r.ok && r.claims.role === "control";
}

const RevokeBody = z.strictObject({ link: z.string().regex(/^[0-9a-z-]+$/).max(64) });
const JoinBody = z.strictObject({ code: z.string().regex(/^\d{6}$/), name: z.string().trim().min(1).max(40) });

/** Join attempts per IP and minute (a wrong code must not be brute-forced). */
const JOIN_LIMIT = 10;

export function buildHttpApp(deps: HttpDeps, options: FastifyServerOptions): FastifyInstance {
  const app = Fastify(options);
  // No CORS headers at all: cross-origin reads stay blocked by browsers (doc 10).
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
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
    return { ...deps.links(), joinCode: deps.joinCode() };
  });

  /** Live status for the control room: presence + journal health (polled every few seconds). */
  app.get<{ Querystring: { t?: string } }>("/api/status", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return { ...deps.health(), presence: deps.presence() };
  });

  /** Starts a new game from a game document (imported CSV, template). Control token only; journaled. */
  app.post<{ Querystring: { t?: string } }>("/api/session", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    const body = z.strictObject({ game: z.unknown() }).safeParse(req.body);
    const r = loadGameDocument(body.success ? body.data.game : null);
    if (!r.ok) return reply.code(400).send({ error: "jeu invalide", detail: r.error });
    const s = deps.newSession(r.value);
    return { sessionId: s.id, title: r.value.title, joinCode: deps.joinCode() };
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
    if (body.data.code !== deps.joinCode()) return reply.code(403).send({ error: "Code incorrect" });
    const r = deps.join(body.data.name);
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
  app.get("/assets/preview.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(PREVIEW_JS));
  app.get("/assets/preview.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(PREVIEW_CSS));
  app.get("/", async (_req, reply) => reply.type("text/plain; charset=utf-8").send("Quiz — serveur de show. Liens : console du serveur et links.txt dans le dossier de données.\n"));
  return app;
}
