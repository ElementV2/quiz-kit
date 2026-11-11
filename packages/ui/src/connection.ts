import { createSignal, onCleanup, type Accessor } from "solid-js";
import { QuizClient, localStorageIntentStore, memoryIntentStore, type ClientStatus } from "@quiz/protocol";
import type { AckMessage } from "@quiz/protocol";
import type { Action, View, Viewer } from "@quiz/schema";

export type QuizConnection = {
  readonly view: Accessor<View | null>;
  readonly viewer: Accessor<Viewer | null>;
  readonly status: Accessor<ClientStatus>;
  readonly statusDetail: Accessor<string | undefined>;
  readonly queued: Accessor<number>;
  /** Server time estimate (ms) for countdowns. */
  readonly serverNow: () => number;
  readonly submit: (action: Action) => Promise<AckMessage>;
  readonly client: QuizClient;
};

/** Token from `?t=` (links printed by the server / pasted in OBS). */
export function tokenFromUrl(): string {
  return new URLSearchParams(location.search).get("t") ?? "";
}

/** Stable per-device id (localStorage works over plain HTTP, ADR-0012). */
function deviceId(): string {
  try {
    const existing = localStorage.getItem("quiz.clientId");
    if (existing !== null && /^c_[0-9a-f]{16,}$/.test(existing)) return existing;
    const id = `c_${randomHex(12)}`;
    localStorage.setItem("quiz.clientId", id);
    return id;
  } catch {
    return `c_${randomHex(12)}`;
  }
}

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b); // available in insecure contexts (randomUUID is not)
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function storageOrNull(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/**
 * One WebSocket per app (CONVENTIONS « Front »), exposed as Solid signals. Intents persist in localStorage
 * (per token) so a reload never loses an un-acked answer.
 */
export function createQuizConnection(opts: { token?: string; persist?: boolean; preview?: boolean } = {}): QuizConnection {
  const token = opts.token ?? tokenFromUrl();
  const [view, setView] = createSignal<View | null>(null);
  const [viewer, setViewer] = createSignal<Viewer | null>(null);
  const [status, setStatus] = createSignal<ClientStatus>("connecting");
  const [detail, setDetail] = createSignal<string | undefined>(undefined);
  const [queued, setQueued] = createSignal(0);
  const storage = storageOrNull();
  const store = opts.persist === false || storage === null ? memoryIntentStore() : localStorageIntentStore(`quiz.intents.${token.slice(-24)}`, storage);
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const client: QuizClient = new QuizClient({
    url: `${scheme}://${location.host}/ws`,
    token,
    // Control-room previews are not "real" outputs: the checklist must not count them (prefix read by the server).
    clientId: opts.preview === true ? `c_preview${randomHex(8)}` : deviceId(),
    socket: (u) => new WebSocket(u),
    store,
    onView: (v) => {
      setView(v);
      setViewer(client.viewer);
      setQueued(client.queued.length);
    },
    onStatus: (s, d) => {
      setStatus(s);
      setDetail(d);
    },
    onAck: () => setQueued(client.queued.length),
  });
  client.start();
  onCleanup(() => client.stop());
  return {
    view,
    viewer,
    status,
    statusDetail: detail,
    queued,
    serverNow: () => client.serverNow(),
    submit: (a) => {
      const p = client.submit(a);
      setQueued(client.queued.length);
      return p;
    },
    client,
  };
}
