import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import { ChatIngest, voteOf, type ChatMessage } from "./ingest.ts";
import { TwitchChat, type Fetch } from "./twitch.ts";
import { YouTubeChat } from "./youtube.ts";

const OPTIONS = [{ id: "a", label: "Le Rhône" }, { id: "b", label: "La Loire" }, { id: "c", label: "La Seine" }];

describe("voteOf", () => {
  it("reads letters, numbers, !commands and labels; ignores chatter", () => {
    for (const [text, id] of [["A", "a"], ["b", "b"], ["!c", "c"], ["2", "b"], ["b) je pense", "b"], ["la loire", "b"], ["  Seine ", "c"]] as const) expect(voteOf(text, OPTIONS)).toBe(id);
    for (const text of ["bonjour", "d", "4", "abc", "", "best"]) expect(voteOf(text, OPTIONS)).toBeNull();
  });
});

type Queued = { action: unknown; actor: unknown };
function fakeRuntime(phase = "open") {
  const queued: Queued[] = [];
  const view = { phase, mechanic: { mechanic: "crowd-vote", options: OPTIONS } };
  return {
    queued,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double: only the two methods ChatIngest calls
    rt: { welcomeView: () => view, enqueue: (action: unknown, actor: unknown) => queued.push({ action, actor }) } as never,
  };
}
function manualTimers() {
  const fns: (() => void)[] = [];
  return { fns, timers: { set: (fn: () => void) => { fns.push(fn); return () => undefined; } } };
}

const msg = (userId: string, text: string): ChatMessage => ({ platform: "tw", userId, text });

describe("ChatIngest", () => {
  it("batches votes into one system crowd.tally, last vote per viewer, anti-spam per viewer", () => {
    const { rt, queued } = fakeRuntime();
    const { fns, timers } = manualTimers();
    let now = 0;
    const ing = new ChatIngest({ runtime: () => rt, timers, clock: () => now, minIntervalMs: 1000 });
    ing.push(msg("1", "A"));
    ing.push(msg("1", "B")); // too fast: rate limited
    ing.push(msg("2", "salut")); // not a vote
    ing.push(msg("bad id!", "A"));
    now = 1500;
    ing.push(msg("1", "C"));
    ing.push({ platform: "yt", userId: "UCabc", text: "2" });
    expect(fns).toHaveLength(1);
    fns[0]?.();
    expect(queued).toEqual([{ action: { type: "crowd.tally", votes: [{ userId: "tw:1", optionId: "c" }, { userId: "yt:UCabc", optionId: "b" }] }, actor: { role: "system" } }]);
    expect(ing.stats).toMatchObject({ received: 6, votes: 3, rateLimited: 1, ignored: 2, batches: 1 });
  });

  it("ignores votes when no crowd vote is on air", () => {
    const { rt, queued } = fakeRuntime("idle");
    const { fns, timers } = manualTimers();
    const ing = new ChatIngest({ runtime: () => rt, timers, clock: () => 0 });
    ing.push({ platform: "tw", userId: "1", text: "A" });
    expect(fns).toHaveLength(0);
    expect(queued).toHaveLength(0);
  });
});

const dirs: string[] = [];
const servers: WebSocketServer[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const urlOf = (input: string | URL | Request): string => (typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("TwitchChat (fake EventSub + Helix)", () => {
  it("subscribes after the welcome with the session id, forwards chat, filters shared chat, follows a reconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-tw-"));
    dirs.push(dir);
    const tokenPath = join(dir, "twitch-token.json");
    writeFileSync(tokenPath, JSON.stringify({ accessToken: "acc", refreshToken: "ref", expiresAt: Date.now() + 3_600_000 }));
    const wss = new WebSocketServer({ port: 0 });
    servers.push(wss);
    const port = (wss.address() as { port: number }).port; // oxlint-disable-line typescript/no-unsafe-type-assertion -- ws server bound to a TCP port
    const sockets: ServerSocket[] = [];
    let n = 0;
    const send = (ws: ServerSocket, type: string, payload: unknown) => ws.send(JSON.stringify({ metadata: { message_id: `m${n++}`, message_type: type, message_timestamp: new Date().toISOString() }, payload }));
    wss.on("connection", (ws, req) => {
      sockets.push(ws);
      send(ws, "session_welcome", { session: { id: req.url === "/again" ? "s2" : "s1", status: "connected", keepalive_timeout_seconds: 10, reconnect_url: null, connected_at: "" } });
    });
    const calls: { url: string; body: string | null }[] = [];
    const fake: Fetch = async (input, init) => {
      const url = urlOf(input);
      calls.push({ url, body: typeof init?.body === "string" ? init.body : null });
      if (url.endsWith("/users")) return json({ data: [{ id: "999", login: "moi" }] });
      if (url.includes("/users?login=")) return json({ data: [{ id: "123", login: "chaine" }] });
      if (url.endsWith("/eventsub/subscriptions")) return json({ data: [{}], total: 1, total_cost: 0, max_total_cost: 10 }, 202);
      return json({}, 404);
    };
    const got: ChatMessage[] = [];
    const tw = new TwitchChat({ clientId: "abcdefghij", tokenPath, onMessage: (m) => got.push(m), log: { info: () => undefined, warn: () => undefined }, fetch: fake, eventsubUrl: `ws://127.0.0.1:${port}/ws` });
    await tw.start("chaine");
    await new Promise((r) => setTimeout(r, 150));
    expect(tw.status.state).toBe("live");
    const sub = calls.find((c) => c.url.endsWith("/eventsub/subscriptions"));
    expect(JSON.parse(sub?.body ?? "{}")).toEqual({ type: "channel.chat.message", version: "1", condition: { broadcaster_user_id: "123", user_id: "999" }, transport: { method: "websocket", session_id: "s1" } });
    const first = sockets[0];
    if (first === undefined) throw new Error("no socket");
    send(first, "notification", { subscription: {}, event: { broadcaster_user_id: "123", chatter_user_id: "42", message: { text: "B" }, source_broadcaster_user_id: null } });
    send(first, "notification", { subscription: {}, event: { broadcaster_user_id: "123", chatter_user_id: "43", message: { text: "A" }, source_broadcaster_user_id: "777" } });
    // Planned reconnect: new URL, no new subscription.
    send(first, "session_reconnect", { session: { id: "s1", status: "reconnecting", keepalive_timeout_seconds: null, reconnect_url: `ws://127.0.0.1:${port}/again`, connected_at: "" } });
    await new Promise((r) => setTimeout(r, 200));
    expect(got).toEqual([{ platform: "tw", userId: "42", text: "B" }]);
    expect(sockets).toHaveLength(2);
    expect(calls.filter((c) => c.url.endsWith("/eventsub/subscriptions"))).toHaveLength(1);
    tw.stop();
    expect(tw.status.state).toBe("off");
  });

  it("device login stores the tokens atomically (single-use refresh token)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiz-tw-"));
    dirs.push(dir);
    const tokenPath = join(dir, "twitch-token.json");
    let polls = 0;
    const fake: Fetch = async (input) => {
      const url = urlOf(input);
      if (url.endsWith("/oauth2/device")) return json({ device_code: "dc", user_code: "ABCD-EFGH", verification_uri: "https://www.twitch.tv/activate", expires_in: 60, interval: 0 });
      if (url.endsWith("/oauth2/token")) return ++polls < 2 ? json({ status: 400, message: "authorization_pending" }, 400) : json({ access_token: "A", refresh_token: "R", expires_in: 14_000 });
      return json({}, 404);
    };
    const tw = new TwitchChat({ clientId: "abcdefghij", tokenPath, onMessage: () => undefined, log: { info: () => undefined, warn: () => undefined }, fetch: fake });
    expect(await tw.startLogin()).toEqual({ verificationUri: "https://www.twitch.tv/activate", userCode: "ABCD-EFGH" });
    await new Promise((r) => setTimeout(r, 2500));
    expect(JSON.parse(readFileSync(tokenPath, "utf8"))).toMatchObject({ accessToken: "A", refreshToken: "R" });
    expect(tw.hasToken).toBe(true);
  });
});

describe("YouTubeChat (fake Data API)", () => {
  it("finds the live chat, skips the backlog page, forwards text messages only, honours the polling interval", async () => {
    let page = 0;
    const fake: Fetch = async (input) => {
      const url = urlOf(input);
      if (url.includes("/videos?")) return json({ items: [{ liveStreamingDetails: { activeLiveChatId: "chat1" } }] });
      page++;
      const items = page === 1
        ? [{ snippet: { type: "textMessageEvent", textMessageDetails: { messageText: "A" } }, authorDetails: { channelId: "UCold" } }]
        : [{ snippet: { type: "textMessageEvent", textMessageDetails: { messageText: "B" } }, authorDetails: { channelId: "UCnew" } }, { snippet: { type: "superChatEvent" }, authorDetails: { channelId: "UCx" } }];
      return json({ nextPageToken: `p${page}`, pollingIntervalMillis: 50, items, ...(page >= 3 ? { offlineAt: "2026-11-11T20:00:00Z" } : {}) });
    };
    const got: ChatMessage[] = [];
    const yt = new YouTubeChat({ apiKey: "k".repeat(39), onMessage: (m) => got.push(m), fetch: fake, minIntervalMs: 10 });
    await yt.start("dQw4w9WgXcQ");
    await new Promise((r) => setTimeout(r, 300));
    expect(got).toEqual([{ platform: "yt", userId: "UCnew", text: "B" }, { platform: "yt", userId: "UCnew", text: "B" }]);
    expect(yt.status.state).toBe("ended");
  });
});
