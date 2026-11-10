import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from "fastify";
import { z } from "zod";
import type { Links } from "../links.ts";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import { verifyToken } from "../tokens.ts";
import { PREVIEW_CSS, PREVIEW_HTML, PREVIEW_JS } from "./preview-page.ts";

export type HttpDeps = {
  readonly runtime: () => SessionRuntime;
  readonly links: () => Links;
  readonly revoke: (linkId: string) => Links;
  readonly secret: string;
  readonly show: string;
  readonly isRevoked: (jti: string) => boolean;
  readonly clock: () => number;
  readonly connections: () => number;
  readonly health: () => Record<string, unknown>;
  readonly dataDir: string;
};

/** Tokens live in URLs (OBS, QR codes): never let them reach the logs (doc 10). */
export const redactToken = (url: string | undefined): string => (url ?? "").replace(/([?&]t=)[^&#]+/g, "$1[redacted]");

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer", // the token is in the URL: never leak it through Referer
  // Phase 1: the control room will embed outputs; relax to `frame-ancestors 'self'` then.
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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

const page = async (_req: unknown, reply: { type(t: string): { send(b: string): unknown } }) => reply.type("text/html; charset=utf-8").send(PREVIEW_HTML);

function controlToken(deps: HttpDeps, req: FastifyRequest<{ Querystring: { t?: string } }>): boolean {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const token = req.query.t ?? bearer ?? "";
  const r = verifyToken(deps.secret, token, { now: deps.clock(), show: deps.show, isRevoked: deps.isRevoked });
  return r.ok && r.claims.role === "control";
}

const RevokeBody = z.strictObject({ link: z.string().regex(/^[0-9a-z-]+$/).max(64) });

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

  /** Every link (with tokens) for the control room — requires the control token. */
  app.get<{ Querystring: { t?: string } }>("/api/links", async (req, reply) => {
    if (!controlToken(deps, req)) return reply.code(401).send({ error: "jeton régie requis" });
    return deps.links();
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

  app.get("/control", page);
  app.get("/host", page);
  app.get("/out/:scene", page);
  app.get("/seat/:n", page);
  app.get("/assets/preview.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(PREVIEW_JS));
  app.get("/assets/preview.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(PREVIEW_CSS));
  app.get("/", async (_req, reply) => reply.type("text/plain; charset=utf-8").send("Quiz — serveur de show. Liens : console du serveur et links.txt dans le dossier de données.\n"));
  return app;
}
