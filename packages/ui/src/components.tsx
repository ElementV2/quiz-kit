import { Show, type JSX, type ParentProps } from "solid-js";
import type { ClientStatus } from "@quiz/protocol";

/** Design system of the internal apps (control, host, player). Plain CSS classes from ui.css. */

export function Button(p: ParentProps<{ onClick: () => void; kind?: "primary" | "secondary" | "danger" | "ghost"; disabled?: boolean; title?: string; big?: boolean }>): JSX.Element {
  return (
    <button type="button" class={`q-btn q-btn-${p.kind ?? "primary"}${p.big === true ? " q-btn-big" : ""}`} disabled={p.disabled} title={p.title} onClick={() => p.onClick()}>
      {p.children}
    </button>
  );
}

export function Panel(p: ParentProps<{ title?: string; class?: string }>): JSX.Element {
  return (
    <section class={`q-panel ${p.class ?? ""}`}>
      <Show when={p.title}>
        <h2 class="q-panel-title">{p.title}</h2>
      </Show>
      {p.children}
    </section>
  );
}

const STATUS_LABEL: Record<ClientStatus, string> = {
  connecting: "connexion…",
  open: "connecté",
  reconnecting: "reconnexion…",
  rejected: "accès refusé",
  stopped: "arrêté",
};

export function StatusPill(p: { status: ClientStatus; queued?: number; detail?: string | undefined }): JSX.Element {
  return (
    <span class={`q-status q-status-${p.status}`} title={p.detail}>
      {STATUS_LABEL[p.status]}
      <Show when={(p.queued ?? 0) > 0}> · {p.queued} en attente</Show>
    </span>
  );
}
