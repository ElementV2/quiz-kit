import { For, Match, Show, Switch, createResource, createSignal, onCleanup, type JSX } from "solid-js";
import { Button } from "@quiz/ui";

/**
 * « API de contrôle » (Companion / Stream Deck / OSC, docs/api/control.md) and « Chat » (Twitch / YouTube vote,
 * docs/api/chat.md). Read-only reference and server calls: no game rule here.
 */

export type WithToken = (path: string) => string;

/** Copies a text; over plain HTTP the clipboard API may be missing → manual copy prompt. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    window.prompt("Copier :", text); // oxlint-disable-line no-alert -- clipboard API needs a secure context; manual copy fallback
    return false;
  }
}

function CopyRow(p: { readonly label: string; readonly value: string; readonly shown?: string }): JSX.Element {
  const [done, setDone] = createSignal(false);
  return (
    <div class="c-copy">
      <span class="q-label">{p.label}</span>
      <code class="c-code-line" title={p.shown === undefined ? p.value : undefined}>{p.shown ?? p.value}</code>
      <Button kind="secondary" onClick={() => void copyText(p.value).then((ok) => setDone(ok))}>{done() ? "Copié" : "Copier"}</Button>
    </div>
  );
}

const COMMANDS: readonly (readonly [string, string, string])[] = [
  ["next", "—", "Étape suivante (comme Espace)"],
  ["open · lock · reveal", "—", "Ouvrir · fermer · révéler"],
  ["undo", "—", "Annuler la dernière action"],
  ["timer-add", "secondes (10)", "Rallonger le chrono"],
  ["timer-stop", "—", "Arrêter le chrono"],
  ["layer-take · layer-out · layer-toggle", "id de couche", "Couche manuelle à l'antenne"],
  ["buzz", "n° de siège", "Buzz pour ce siège"],
  ["judge", "1 bonne · 0 mauvaise", "Juger qui a la main"],
  ["hint", "—", "Indice / case suivante"],
  ["joker", "fifty · audience", "Joker des paliers"],
  ["stop", "—", "Le candidat s'arrête"],
];

export function ApiInfo(p: { readonly origin: string; readonly token: string }): JSX.Element {
  const masked = () => `Bearer ${p.token.slice(0, 6)}…${p.token.slice(-4)}`;
  return (
    <div class="c-stack">
      <CopyRow label="Base URL (Companion « Generic: HTTP Requests »)" value={`${p.origin}/api/v1/`} />
      <CopyRow label="En-tête Authorization" value={`Bearer ${p.token}`} shown={masked()} />
      <p class="muted">POST <code>&lt;base&gt;&lt;commande&gt;</code>, argument en <code>?arg=3</code> ou <code>{'{"args":[3]}'}</code>. État : GET <code>state</code>. En-tête <code>Idempotency-Key</code> conseillé : un appui renvoyé n'est exécuté qu'une fois.</p>
      <p class="muted">OSC (UDP) : <code>/quiz/&lt;commande&gt;</code>, seulement si <code>QUIZ_OSC_PORT</code> et <code>QUIZ_OSC_ALLOW</code> (émetteurs autorisés) sont réglés ; <code>undo</code> n'y est pas accepté.</p>
      <table class="c-table c-table-dense">
        <thead><tr><th>Commande</th><th>Argument</th><th>Effet</th></tr></thead>
        <tbody><For each={COMMANDS}>{([c, a, d]) => <tr><td><code>{c}</code></td><td class="muted">{a}</td><td>{d}</td></tr>}</For></tbody>
      </table>
      <p class="muted">Ce jeton donne la régie complète : ne le coller que dans Companion, jamais dans un chat.</p>
    </div>
  );
}

type ChatState = {
  twitch: { state: string; channel: string | null; login: { verificationUri: string; userCode: string } | null; error: string | null; messages: number; authorised: boolean } | null;
  youtube: { state: string; videoId: string | null; error: string | null; messages: number; calls: number } | null;
  ingest: { received: number; votes: number; ignored: number; rateLimited: number; batches: number };
};

const STATE_LABEL: Record<string, string> = { off: "arrêté", login: "connexion du compte…", connecting: "connexion…", live: "en direct", error: "erreur" };

const isChatState = (x: unknown): x is ChatState => typeof x === "object" && x !== null && "ingest" in x;

export function ChatPanel(p: { readonly withToken: WithToken }): JSX.Element {
  const [msg, setMsg] = createSignal<string | null>(null);
  const [channel, setChannel] = createSignal("");
  const [videoId, setVideoId] = createSignal("");
  const [state, { refetch }] = createResource(async (): Promise<ChatState | null> => {
    try {
      const r = await fetch(p.withToken("/api/chat"));
      const body: unknown = await r.json();
      return r.ok && isChatState(body) ? body : null;
    } catch {
      return null;
    }
  });
  // Every 2 s while a login is pending or a connector is connecting, else every 6 s (counters).
  let ticks = 0;
  const timer = setInterval(() => {
    const s = state();
    const pending = s?.twitch?.state === "login" || s?.twitch?.state === "connecting" || s?.youtube?.state === "connecting";
    if (pending || ++ticks % 3 === 0) void refetch();
  }, 2000);
  onCleanup(() => clearInterval(timer));
  const post = async (path: string, body?: object) => {
    try {
      const r = await fetch(p.withToken(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
      const data: unknown = await r.json().catch(() => ({}));
      setMsg(r.ok ? null : typeof data === "object" && data !== null && "error" in data ? String(data.error) : `refusé (${r.status})`);
    } catch {
      setMsg("serveur injoignable");
    }
    void refetch();
  };
  return (
    <div class="c-stack">
      <Show when={state()} fallback={<p class="muted">État du chat indisponible.</p>}>
        {(s) => (
          <>
            <div class="c-chat">
              <span class="q-label">Twitch</span>
              <Show when={s().twitch} fallback={<p class="muted">Twitch non configuré (QUIZ_TWITCH_CLIENT_ID)</p>}>
                {(t) => (
                  <>
                    <p><span class="q-tally" data-on={t().state === "live" ? "ok" : t().state === "error" ? "air" : undefined}>{STATE_LABEL[t().state] ?? t().state}</span>{t().channel === null ? "" : ` · ${t().channel}`} · <span class="q-mono">{t().messages}</span> message(s)</p>
                    <Show when={t().login}>{(l) => <p class="c-warn">Ouvrir <b>{l().verificationUri.replace(/^https?:\/\/(www\.)?/, "")}</b> et saisir le code <b class="q-mono">{l().userCode}</b></p>}</Show>
                    <Show when={t().error}>{(e) => <p class="c-err">{e()}</p>}</Show>
                    <Switch>
                      <Match when={!t().authorised}><Button onClick={() => void post("/api/chat/twitch/login")}>Connecter le compte Twitch</Button></Match>
                      <Match when={t().state === "off" || t().state === "error"}>
                        <div class="c-add"><input placeholder="Chaîne à lire" value={channel()} onInput={(e) => setChannel(e.currentTarget.value)} /><Button disabled={channel().trim() === ""} onClick={() => void post("/api/chat/twitch/start", { channel: channel().trim() })}>Lire le chat</Button></div>
                      </Match>
                      <Match when={true}><Button kind="danger" onClick={() => void post("/api/chat/twitch/stop")}>Arrêter Twitch</Button></Match>
                    </Switch>
                  </>
                )}
              </Show>
            </div>
            <div class="c-chat">
              <span class="q-label">YouTube</span>
              <Show when={s().youtube} fallback={<p class="muted">YouTube non configuré (QUIZ_YOUTUBE_API_KEY)</p>}>
                {(y) => (
                  <>
                    <p><span class="q-tally" data-on={y().state === "live" ? "ok" : y().state === "error" ? "air" : undefined}>{STATE_LABEL[y().state] ?? y().state}</span>{y().videoId === null ? "" : ` · ${y().videoId}`} · <span class="q-mono">{y().messages}</span> message(s) · <span class="q-mono">{y().calls}</span> appel(s) API</p>
                    <Show when={y().error}>{(e) => <p class="c-err">{e()}</p>}</Show>
                    <Show when={y().state === "off" || y().state === "error"} fallback={<Button kind="danger" onClick={() => void post("/api/chat/youtube/stop")}>Arrêter YouTube</Button>}>
                      <div class="c-add"><input placeholder="ID de la vidéo en direct" value={videoId()} onInput={(e) => setVideoId(e.currentTarget.value)} /><Button disabled={videoId().trim() === ""} onClick={() => void post("/api/chat/youtube/start", { videoId: videoId().trim() })}>Lire le chat</Button></div>
                    </Show>
                    <p class="muted">Quota : ne lire le chat que pendant les manches de vote.</p>
                  </>
                )}
              </Show>
            </div>
            <p class="muted q-mono">reçus {s().ingest.received} · votes {s().ingest.votes} · ignorés {s().ingest.ignored} · limités {s().ingest.rateLimited}</p>
          </>
        )}
      </Show>
      <Show when={msg()}>{(m) => <p class="c-err">{m()}</p>}</Show>
    </div>
  );
}

/** Regenerates the home-page team code (`POST /api/staff/rotate`). */
export function StaffCode(p: { readonly withToken: WithToken }): JSX.Element {
  const [msg, setMsg] = createSignal<string | null>(null);
  const [code, setCode] = createSignal<string | null>(null);
  const rotate = async () => {
    // oxlint-disable-next-line no-alert -- irreversible action confirmation (doc 08)
    if (!window.confirm("Générer un nouveau code équipe ? Les postes qui l'ont retenu devront le ressaisir.")) return;
    try {
      const r = await fetch(p.withToken("/api/staff/rotate"), { method: "POST" });
      const body: unknown = await r.json().catch(() => ({}));
      if (r.ok && typeof body === "object" && body !== null && "staffCode" in body && typeof body.staffCode === "string") {
        setCode(body.staffCode);
        setMsg(null);
      } else setMsg(typeof body === "object" && body !== null && "error" in body ? String(body.error) : `refusé (${r.status})`);
    } catch {
      setMsg("serveur injoignable");
    }
  };
  return (
    <div class="c-stack">
      <p class="muted">Le code équipe déverrouille tous les postes depuis l'accueil (<code>/</code>).</p>
      <div class="c-row c-row-tight"><Button kind="danger" onClick={() => void rotate()}>Nouveau code équipe</Button></div>
      <Show when={code()}>{(c) => <p>Nouveau code : <b class="q-mono c-big-code">{c()}</b></p>}</Show>
      <Show when={msg()}>{(m) => <p class="c-err">{m()}</p>}</Show>
    </div>
  );
}
