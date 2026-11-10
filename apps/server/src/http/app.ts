import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { Links } from "../links.ts";
import type { SessionRuntime } from "../runtime/session-runtime.ts";
import { verifyToken } from "../tokens.ts";
import { PREVIEW_CSS, PREVIEW_HTML, PREVIEW_JS } from "./preview-page.ts";

export type HttpDeps = {
  readonly runtime: () => SessionRuntime;
  readonly links: () => Links;
  readonly secret: string;
  readonly show: string;
  readonly isRevoked: (jti: string) => boolean;
  readonly clock: () => number;
  readonly connections: () => number;
  readonly health: () => Record<string, unknown>;
};

/** Tokens live in URLs (OBS, QR codes): never let them reach the logs (doc 10). */
export const redactToken = (url: string | undefined): string => (url ?? "").replace(/([?&]t=)[^&]+/g, "$1[redacted]");

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer", // the token is in the URL: never leak it through Referer
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

export function loggerOptions(level: string) {
  return {
    level,
    serializers: {
      req: (req: { method?: string; url?: string }) => ({ method: req.method ?? "", url: redactToken(req.url) }),
    },
  };
}

const page = async (_req: unknown, reply: { type(t: string): { send(b: string): unknown } }) => reply.type("text/html; charset=utf-8").send(PREVIEW_HTML);

export function buildHttpApp(deps: HttpDeps, options: FastifyServerOptions): FastifyInstance {
  const app = Fastify(options);
  // No CORS headers at all: cross-origin reads stay blocked by browsers (doc 10).
  app.addHook("onSend", async (_req, reply, payload) => {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) reply.header(k, v);
    return payload;
  });

  app.get("/health", async () => ({ ok: true, ...deps.health(), clients: deps.connections() }));

  /** Every link (with tokens) for the control room — requires the control token. */
  app.get<{ Querystring: { t?: string } }>("/api/links", async (req, reply) => {
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    const token = req.query.t ?? bearer ?? "";
    const r = verifyToken(deps.secret, token, { now: deps.clock(), show: deps.show, isRevoked: deps.isRevoked });
    if (!r.ok || r.claims.role !== "control") return reply.code(401).send({ error: "jeton régie requis" });
    return deps.links();
  });

  app.get("/control", page);
  app.get("/host", page);
  app.get("/out/:scene", page);
  app.get("/seat/:n", page);
  app.get("/assets/preview.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(PREVIEW_JS));
  app.get("/assets/preview.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(PREVIEW_CSS));
  app.get("/", async (_req, reply) => reply.type("text/plain; charset=utf-8").send("Quiz — serveur de show. Les liens sont affichés dans la console du serveur et dans data/links.txt.\n"));
  return app;
}
