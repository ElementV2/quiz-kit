import { z } from "zod";

const list = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0))
  .pipe(z.array(z.string().regex(/^[0-9a-z-]+$/)).min(1));

/** Server configuration from environment variables (validated: CONVENTIONS, every boundary). */
export const Config = z.object({
  /** Interface to bind. 0.0.0.0 = every network card, so OBS / vMix / tablets on other PCs can connect. */
  host: z.string().default("0.0.0.0"),
  port: z.coerce.number().int().min(1).max(65_535).default(7300),
  dataDir: z.string().default(".data"),
  /** Installation name: role tokens are per show, so links survive restarts and new sessions. */
  show: z.string().regex(/^[0-9a-z-]+$/).default("main"),
  /** Output scenes to generate links for. */
  outputs: list.default(["program", "wall", "leaderboard"]),
  seats: z.coerce.number().int().min(0).max(999).default(8),
  /** Game document to start a new session with (JSON file). Default: demo game. */
  game: z.string().optional(),
  /** Start a fresh session even if one exists in the journal. */
  newSession: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  /** Extra host names / IPs to print links for (comma separated), e.g. a DNS name on the VPN. */
  publicHosts: z.string().default("").transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0)),
  logLevel: z.enum(["fatal", "error", "warn", "info", "debug"]).default("info"),
  /** UDP port of the OSC control API (Companion "Generic: OSC"). Absent: OSC off (UDP has no authentication). */
  oscPort: z.coerce.number().int().min(1).max(65_535).optional(),
  /** Only these sender IPs may drive the show over OSC (comma separated). Empty: any host of the LAN. */
  oscAllow: z.string().default("").transform((s) => s.split(",").map((x) => x.trim()).filter((x) => x.length > 0)),
  /** Twitch application Client ID (public client, Device Code flow): enables the Twitch chat connector. */
  twitchClientId: z.string().regex(/^[0-9a-z]{10,64}$/).optional(),
  /** YouTube Data API key: enables the YouTube live chat connector (polling). */
  youtubeApiKey: z.string().regex(/^[0-9A-Za-z_-]{20,80}$/).optional(),
  /** Hot standby: address of the primary show server to mirror (e.g. http://192.168.1.20:7300). Absent: primary. */
  standbyOf: z.url().regex(/^https?:\/\//).optional(),
  /** Control token of the primary (from its home page / links.txt): the standby reads its journal with it. */
  standbyToken: z.string().min(10).max(2000).optional(),
  /** Team access code of the home page (8+ chars). Absent: generated once, kept in the data dir; rotate from the control room. */
  staffCode: z.string().regex(/^[0-9A-Z]{8,16}$/, "QUIZ_STAFF_CODE : 8 à 16 caractères (chiffres, majuscules)").optional(),
});
export type Config = z.infer<typeof Config>;

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  return Config.parse({
    host: env["QUIZ_HOST"],
    port: env["QUIZ_PORT"],
    dataDir: env["QUIZ_DATA_DIR"],
    show: env["QUIZ_SHOW"],
    outputs: env["QUIZ_OUTPUTS"],
    seats: env["QUIZ_SEATS"],
    game: env["QUIZ_GAME"],
    newSession: env["QUIZ_NEW_SESSION"],
    publicHosts: env["QUIZ_PUBLIC_HOSTS"],
    logLevel: env["QUIZ_LOG_LEVEL"],
    staffCode: env["QUIZ_STAFF_CODE"],
    standbyOf: env["QUIZ_STANDBY_OF"],
    standbyToken: env["QUIZ_STANDBY_TOKEN"],
    oscPort: env["QUIZ_OSC_PORT"],
    twitchClientId: env["QUIZ_TWITCH_CLIENT_ID"],
    youtubeApiKey: env["QUIZ_YOUTUBE_API_KEY"],
    oscAllow: env["QUIZ_OSC_ALLOW"],
  });
}
