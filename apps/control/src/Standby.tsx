import { Show, createResource, createSignal, onCleanup, type JSX } from "solid-js";
import { Button, confirmDialog } from "@quiz/ui";
import { api, withToken } from "./api.ts";

/** `GET /api/standby` (apps/server/src/standby.ts): null on a primary server. */
type StandbyStatus = {
  readonly mode: "standby" | "promoted";
  readonly primary: string;
  readonly lag: number;
  readonly lastContactAt: number | null;
  readonly error: string | null;
  readonly mediaMissing: number;
  readonly diverged: string | null;
};

const ago = (at: number | null): string => {
  if (at === null) return "jamais";
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  return s < 2 ? "à l'instant" : `il y a ${s} s`;
};

/**
 * Backup server (doc 05): only on a standby. Says how far behind the copy is and offers « Basculer » (manual,
 * confirmed: never automatic, two servers must not decide at once). Nothing at all on the main server.
 */
export function StandbyBar(): JSX.Element {
  const [msg, setMsg] = createSignal<string | null>(null);
  const [status, { refetch }] = createResource(async (): Promise<StandbyStatus | null> => {
    try {
      return (await api<{ standby: StandbyStatus | null }>("/api/standby")).standby;
    } catch {
      return null;
    }
  });
  // A main server answers null once: no more polling there.
  const timer = setInterval(() => { if (status() !== null) void refetch(); }, 1000);
  onCleanup(() => clearInterval(timer));
  const promote = async (s: StandbyStatus) => {
    const risky = s.diverged !== null || s.mediaMissing > 0 || s.lag > 0;
    const ok = await confirmDialog({
      title: "Basculer sur ce serveur de secours ?",
      message: risky
        ? `Attention : ${s.diverged ?? (s.lag > 0 ? `la copie a ${s.lag} action(s) de retard` : `${s.mediaMissing} média(s) manquent`)}. Ne basculer que si le principal est vraiment en panne. Ensuite, faire pointer les sorties et les tablettes sur ce serveur.`
        : "Ce serveur prend la main sur la partie. Ne basculer que si le principal est vraiment en panne, puis faire pointer les sorties et les tablettes sur ce serveur.",
      confirm: "Basculer",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await fetch(withToken("/api/standby/promote"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ force: risky }) });
      const body: unknown = await r.json().catch(() => ({}));
      setMsg(r.ok ? null : typeof body === "object" && body !== null && "error" in body ? String(body.error) : `refusé (${r.status})`);
    } catch {
      setMsg("serveur injoignable");
    }
    void refetch();
  };
  return (
    <Show when={status()}>
      {(s) => (
        <div class="c-standby" role="status" data-mode={s().mode} data-bad={String(s().error !== null || s().diverged !== null)}>
          <Show
            when={s().mode === "standby"}
            fallback={<span><b>Serveur de secours en service</b> : c'est lui qui mène la partie.</span>}
          >
            <span>
              <b>Serveur de secours</b> · copie de {s().primary} · {s().lag === 0 ? "à jour" : `${s().lag} action(s) de retard`} · dernier contact {ago(s().lastContactAt)}
              <Show when={s().mediaMissing > 0}> · {s().mediaMissing} média(s) manquant(s)</Show>
              <Show when={s().diverged ?? s().error}>{(e) => <> · ⚠ {e()}</>}</Show>
            </span>
            <Button kind="danger" onClick={() => void promote(s())}>Basculer</Button>
          </Show>
          <Show when={msg()}>{(m) => <span class="c-warn-line">{m()}</span>}</Show>
        </div>
      )}
    </Show>
  );
}
