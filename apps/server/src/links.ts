import { networkInterfaces } from "node:os";
import { signToken, type TokenClaims } from "./tokens.ts";

export type LinkEntry = {
  readonly label: string;
  readonly role: TokenClaims["role"];
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

/** IPv4 addresses of every non-internal network card: what OBS / vMix on another PC must use. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) out.push(a.address);
  }
  return out;
}

/**
 * Stable role links (doc 08): same secret + same claims = same token, so URLs pasted in OBS / vMix
 * keep working across restarts. Revoke one with its `jti`, or rotate the secret to revoke them all.
 */
export function buildLinks(opts: {
  secret: string;
  show: string;
  outputs: readonly string[];
  seats: number;
  hosts: readonly string[];
  port: number;
  tlsPort: number | null;
}): Links {
  const base = { v: 1, show: opts.show, exp: null } as const;
  const make = (label: string, path: string, claims: TokenClaims): LinkEntry => ({
    label,
    role: claims.role,
    path: `${path}?t=${signToken(opts.secret, claims)}`,
  });
  const entries: LinkEntry[] = [
    make("Régie", "/control", { ...base, jti: "control", role: "control" }),
    make("Régie (lecture seule)", "/control", { ...base, jti: "control-readonly", role: "control-readonly" }),
    make("Animateur", "/host", { ...base, jti: "host", role: "host" }),
    ...opts.outputs.map((scene) => make(`Sortie ${scene}`, `/out/${scene}`, { ...base, jti: `out-${scene}`, role: "output", scene })),
    ...Array.from({ length: opts.seats }, (_, i) => make(`Siège ${i + 1}`, `/seat/${i + 1}`, { ...base, jti: `seat-${i + 1}`, role: "seat", seat: i + 1 })),
  ];
  const hosts = [...new Set(opts.hosts)];
  return {
    origins: hosts.map((h) => `http://${h}:${opts.port}`),
    secureOrigins: opts.tlsPort === null ? [] : hosts.map((h) => `https://${h}:${opts.tlsPort}`),
    entries,
  };
}

/** Human-readable block printed at startup on the show machine's console. */
export function formatLinks(links: Links): string {
  const first = links.origins[0] ?? "http://localhost";
  const lines = [
    "",
    "════════ Quiz — liens à coller dans OBS / vMix / tablettes ════════",
    `Adresses de ce PC : ${links.origins.join("  ·  ")}`,
    ...(links.secureOrigins.length > 0 ? [`HTTPS (tablettes) : ${links.secureOrigins.join("  ·  ")}`] : []),
    "Depuis un autre PC, utiliser l'IP du réseau plateau (pas localhost).",
    "",
    ...links.entries.map((e) => `  ${e.label.padEnd(24)} ${first}${e.path}`),
    "",
    "Les liens restent valables après un redémarrage. Liste complète : data/links.txt",
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
