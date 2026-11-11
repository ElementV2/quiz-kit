import { For, Show, createMemo, createSignal, onMount, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { renderSVG } from "uqr";
import "@quiz/ui/ui.css";
import "./hub.css";
import { outputs, sceneOf, seats, shareOrigin, spacedCode, stations, type HubData, type HubEntry } from "./hub-logic.ts";

const REMEMBER_KEY = "quiz-hub-code";

function readRemembered(): string | null {
  try {
    return localStorage.getItem(REMEMBER_KEY);
  } catch {
    return null;
  }
}
function writeRemembered(code: string | null): void {
  try {
    if (code === null) localStorage.removeItem(REMEMBER_KEY);
    else localStorage.setItem(REMEMBER_KEY, code);
  } catch {
    // private window / blocked storage: just not remembered
  }
}

async function unlock(code: string | null): Promise<{ ok: true; data: HubData } | { ok: false; error: string; status: number }> {
  const res = await fetch("/api/staff", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(code === null ? {} : { code }) });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- server contract (apps/server/src/http/app.ts /api/staff)
  const body = (await res.json().catch(() => ({}))) as Partial<HubData> & { error?: string };
  if (!res.ok) return { ok: false, error: body.error ?? `erreur ${res.status}`, status: res.status };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same contract, ok response
  return { ok: true, data: body as HubData };
}

const qrDataUrl = (text: string): string => `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(text, { border: 1, whiteColor: "#ece7dc", blackColor: "#121110" }))}`;

function CopyKey(p: { text: string; label?: string }): JSX.Element {
  const [done, setDone] = createSignal(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(p.text);
    } catch {
      // Plain HTTP on a LAN IP: the async clipboard API is unavailable, fall back to a selection copy.
      const t = document.createElement("textarea");
      t.value = p.text;
      document.body.append(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1200);
  };
  return (
    <button type="button" class="q-btn q-btn-secondary h-key" data-done={String(done())} onClick={() => void copy()}>
      {done() ? "Copié" : (p.label ?? "Copier")}
    </button>
  );
}

function Locked(p: { onUnlocked: (d: HubData, code: string | null) => void; error: string | null }): JSX.Element {
  const [code, setCode] = createSignal("");
  const [remember, setRemember] = createSignal(true);
  const [err, setErr] = createSignal<string | null>(p.error);
  const [busy, setBusy] = createSignal(false);
  const submit = async (e: SubmitEvent) => {
    e.preventDefault();
    setBusy(true);
    const r = await unlock(code().trim());
    setBusy(false);
    if (!r.ok) {
      setErr(r.error);
      return;
    }
    writeRemembered(remember() ? code().trim() : null);
    p.onUnlocked(r.data, code().trim());
  };
  return (
    <div class="h-gate">
      <section class="h-gate-col">
        <p class="h-eyebrow">Joueurs</p>
        <h2 class="h-gate-title">Rejoindre la partie</h2>
        <p class="muted">Code à 6 chiffres affiché à l'écran, puis un pseudo.</p>
        <a class="q-btn q-btn-big h-wide" href="/play">Jouer</a>
      </section>
      <form class="h-gate-col" onSubmit={(e) => void submit(e)}>
        <p class="h-eyebrow">Équipe technique</p>
        <h2 class="h-gate-title">Régie, studio, sorties</h2>
        <label class="h-field">
          <span>Code équipe</span>
          <input class="h-code-input" autocapitalize="characters" autocomplete="off" spellcheck={false} maxlength={19} value={code()} onInput={(e) => setCode(e.currentTarget.value.toUpperCase().replaceAll(/[^0-9A-Z]/g, ""))} placeholder="XXXX XXXX" />
        </label>
        <label class="h-check"><input type="checkbox" checked={remember()} onChange={(e) => setRemember(e.currentTarget.checked)} /> Se souvenir sur ce poste</label>
        <Show when={err()}>{(m) => <p class="h-error">{m()}</p>}</Show>
        <button type="submit" class="q-btn q-btn-big h-wide" disabled={busy() || code().length < 8}>Déverrouiller</button>
        <p class="muted h-small">Le code équipe est affiché sur le PC du serveur (ouvrir cette page en <span class="q-mono">localhost</span>) et dans <span class="q-mono">links.txt</span>.</p>
      </form>
    </div>
  );
}

function Unlocked(p: { data: HubData; onLock: () => void }): JSX.Element {
  const origin = createMemo(() => shareOrigin(location.origin, p.data.origins));
  const playUrl = () => `${origin()}/play?code=${p.data.joinCode}`;
  const [seatQr, setSeatQr] = createSignal<HubEntry | null>(null);
  const url = (e: HubEntry) => `${origin()}${e.path}`;
  return (
    <div class="h-board">
      <section class="h-col">
        <h2 class="q-panel-title">Postes</h2>
        <ul class="h-rows">
          <For each={stations(p.data.entries)}>
            {(s) => (
              <li class="h-row h-station">
                <div class="h-row-main">
                  <span class="h-row-name">{s.name}</span>
                  <span class="muted h-row-hint">{s.hint}</span>
                </div>
                <a class="q-btn h-key" href={s.entry.path} target="_blank" rel="noopener">Ouvrir</a>
                <CopyKey text={url(s.entry)} label="Lien" />
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="h-col">
        <h2 class="q-panel-title">Sorties OBS / vMix</h2>
        <p class="muted h-small">Source navigateur · <span class="q-mono">1920 × 1080</span> · fond transparent. Coller le lien dans OBS (Source navigateur) ou vMix (Web Browser).</p>
        <ul class="h-rows">
          <For each={outputs(p.data.entries)}>
            {(e) => (
              <li class="h-row">
                <div class="h-row-main">
                  <span class="h-row-name">{sceneOf(e)}</span>
                  <span class="q-mono h-url" title={url(e)}>{url(e)}</span>
                </div>
                <CopyKey text={url(e)} />
                <a class="q-btn q-btn-ghost h-key" href={e.path} target="_blank" rel="noopener">Aperçu</a>
              </li>
            )}
          </For>
        </ul>
      </section>

      <section class="h-col">
        <h2 class="q-panel-title">Tablettes et téléphones</h2>
        <div class="h-join">
          <img class="h-qr" src={qrDataUrl(playUrl())} alt={`QR code : ${playUrl()}`} />
          <div class="h-join-text">
            <span class="h-eyebrow">Code de la partie</span>
            <span class="h-join-code q-mono">{spacedCode(p.data.joinCode)}</span>
            <span class="q-mono h-url">{origin()}/play</span>
            <CopyKey text={playUrl()} label="Copier le lien" />
          </div>
        </div>
        <details class="h-seats">
          <summary>Sièges fixes ({seats(p.data.entries).length}) — une tablette par pupitre, sans code</summary>
          <ul class="h-rows">
            <For each={seats(p.data.entries)}>
              {(e) => (
                <li class="h-row">
                  <span class="h-row-name">{e.label}</span>
                  <span class="h-spacer" />
                  <button type="button" class="q-btn q-btn-ghost h-key" onClick={() => setSeatQr(seatQr()?.id === e.id ? null : e)}>QR</button>
                  <CopyKey text={url(e)} />
                </li>
              )}
            </For>
          </ul>
          <Show when={seatQr()}>{(e) => <img class="h-qr h-qr-seat" src={qrDataUrl(url(e()))} alt={`QR code : ${e().label}`} />}</Show>
        </details>
      </section>

      <footer class="h-foot">
        <Show when={p.data.staffCode}>
          {(c) => (
            <span class="h-staff">
              <span class="h-eyebrow">Code équipe</span>
              <span class="q-mono h-staff-code">{spacedCode(c())}</span>
              <span class="muted">à donner aux autres postes (affiché seulement sur le PC du serveur)</span>
            </span>
          )}
        </Show>
        <span class="h-spacer" />
        <Show when={!p.data.local}><button type="button" class="q-btn q-btn-ghost" onClick={() => p.onLock()}>Verrouiller ce poste</button></Show>
      </footer>
    </div>
  );
}

function App(): JSX.Element {
  const [data, setData] = createSignal<HubData | null>(null);
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [online, setOnline] = createSignal(true);
  onMount(() => {
    void (async () => {
      // On the server PC (localhost) the server answers without code; elsewhere a remembered code is tried.
      const r = await unlock(readRemembered()).catch(() => null);
      if (r === null) setOnline(false);
      else if (r.ok) setData(r.data);
      else if (r.status === 403 && readRemembered() !== null) {
        writeRemembered(null);
        setError("Le code équipe a changé : entrer le nouveau code.");
      }
      setReady(true);
    })();
  });
  const lock = () => {
    writeRemembered(null);
    setData(null);
  };
  return (
    <div class="h-app">
      <header class="h-top">
        <div class="h-brand">
          <span class="h-logo">QUIZ</span>
          <span class="h-eyebrow">Serveur de show</span>
        </div>
        <span class="h-spacer" />
        <Show when={data()}>{(d) => <span class="h-title"><span class="h-eyebrow">Partie en cours</span>{d().title} <span class="q-mono h-players">{d().players}/{d().maxPlayers} joueurs</span></span>}</Show>
        <span class={`q-status ${online() ? "q-status-open" : "q-status-stopped"}`}>{online() ? "en ligne" : "serveur injoignable"}</span>
      </header>
      <main class="h-main">
        <Show when={ready()} fallback={<p class="muted">Connexion au serveur…</p>}>
          <Show when={data()} fallback={<Locked error={error()} onUnlocked={(d) => setData(d)} />}>
            {(d) => <Unlocked data={d()} onLock={lock} />}
          </Show>
        </Show>
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
