import { networkInterfaces } from "node:os";
import { signToken, type TokenClaims } from "./tokens.ts";

export type LinkEntry = {
  readonly label: string;
  /** Stable link name (`control`, `out-program`, `seat-3`): what you revoke. */
  readonly id: string;
  readonly role: TokenClaims["role"];
  /** Token id = `<id>` then `<id>.<generation>` after each revocation. */
  readonly jti: string;
  /** Path + token, e.g. `/out/program?t=…`. Prefix with any of `origins`. */
  readonly path: string;
};

export type Links = {
  /** Every origin the server is reachable at, e.g. `http://192.168.1.20:7300`. */
  readonly origins: readonly string[];
  /** Origins for tablets when HTTPS is configured (Wake Lock / Service Worker need it, ADR-0012). */
  readonly secureOrigins: readonly string[];
  readonly entries: readonly LinkEntry[];
};

/** Role-specific part of the claims (distributive Omit keeps the union). */
type ClaimBody = TokenClaims extends infer T ? (T extends TokenClaims ? Omit<T, "v" | "show" | "exp" | "jti"> : never) : never;

/** IPv4 addresses of every non-internal network card: what OBS / vMix on another PC must use. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * Stable role links (doc 08): same secret + same claims = same token, so URLs pasted in OBS / vMix keep working
 * across restarts. Shows use links without expiry on purpose (an OBS source must not die mid-show); the
 * mitigation is revocation per link (generation bump, `POST /api/revoke`) and secret rotation (delete secret.key).
 */
export function buildLinks(opts: {
  secret: string;
  show: string;
  outputs: readonly string[];
  seats: number;
  hosts: readonly string[];
  port: number;
  tlsPort: number | null;
  generation: (id: string) => number;
}): Links {
  const base = { v: 1, show: opts.show, exp: null } as const;
  const make = (label: string, id: string, path: string, claims: ClaimBody): LinkEntry => {
    // Generation 0 keeps the historical jti, so links already pasted in OBS stay valid.
    const gen = opts.generation(id);
    const jti = gen === 0 ? id : `${id}.${gen}`;
    const full: TokenClaims = { ...base, jti, ...claims };
    return { label, id, role: full.role, jti, path: `${path}?t=${signToken(opts.secret, full)}` };
  };
  const entries: LinkEntry[] = [
    make("Régie", "control", "/control", { role: "control" }),
    make("Régie (lecture seule)", "control-readonly", "/control", { role: "control-readonly" }),
    make("Animateur", "host", "/host", { role: "host" }),
    make("Studio", "studio", "/studio", { role: "studio" }),
    ...opts.outputs.map((scene) => make(`Sortie ${scene}`, `out-${scene}`, `/out/${scene}`, { role: "output", scene })),
    ...Array.from({ length: opts.seats }, (_, i) => make(`Siège ${i + 1}`, `seat-${i + 1}`, `/seat/${i + 1}`, { role: "seat", seat: i + 1 })),
  ];
  const hosts = [...new Set(opts.hosts)];
  return {
    origins: hosts.map((h) => `http://${h}:${opts.port}`),
    secureOrigins: opts.tlsPort === null ? [] : hosts.map((h) => `https://${h}:${opts.tlsPort}`),
    entries,
  };
}

/**
 * Startup banner. Tokens are printed only on an interactive console (the operator's screen); when stdout is
 * captured (supervisor, service, CI) only the location of links.txt is printed — logs never carry tokens (doc 10).
 */
export function formatLinks(links: Links, linksPath: string, interactive: boolean): string {
  const first = links.origins[0] ?? "http://localhost";
  const lines = [
    "",
    "════════ Quiz — liens à coller dans OBS / vMix / tablettes ════════",
    `Adresses de ce PC : ${links.origins.join("  ·  ")}`,
    ...(links.secureOrigins.length > 0 ? [`HTTPS (tablettes) : ${links.secureOrigins.join("  ·  ")}`] : []),
    "Depuis un autre PC, utiliser l'IP du réseau plateau (pas localhost).",
    "",
    ...(interactive ? links.entries.map((e) => `  ${e.label.padEnd(24)} ${first}${e.path}`) : ["  (console non interactive : liens non affichés)"]),
    "",
    `Liste complète pour chaque adresse : ${linksPath}`,
    "Les liens restent valables après un redémarrage.",
    "════════════════════════════════════════════════════════════════════",
    "",
  ];
  return lines.join("\n");
}

/** Full list, one block per origin, written to the data dir. */
export function linksFile(links: Links): string {
  const blocks = [...links.origins, ...links.secureOrigins].map((origin) =>
    [`# ${origin}`, ...links.entries.map((e) => `${e.label}\t${origin}${e.path}`)].join("\n"),
  );
  return `${blocks.join("\n\n")}\n`;
}
