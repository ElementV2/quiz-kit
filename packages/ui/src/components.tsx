import { Show, createEffect, createMemo, createSignal, onCleanup, type JSX, type ParentProps } from "solid-js";
import type { ClientStatus } from "@quiz/protocol";
import type { Phase } from "@quiz/schema";

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
  taken: "ouvert ailleurs",
  stopped: "arrêté",
};

/**
 * Connection state. Every action waits a few ms for its ack: showing « 1 en attente » for that would make the whole
 * bar jump at each step. The count shows only when the queue lasts (a real backlog: network cut, server busy).
 */
export function StatusPill(p: { status: ClientStatus; queued?: number; detail?: string | undefined }): JSX.Element {
  const [lasting, setLasting] = createSignal(false);
  const waiting = createMemo(() => (p.queued ?? 0) > 0); // 1 → 2 → 3 does not restart the delay
  createEffect(() => {
    if (!waiting()) {
      setLasting(false);
      return;
    }
    const t = setTimeout(() => setLasting(true), 1200);
    onCleanup(() => clearTimeout(t));
  });
  return (
    <span class={`q-status q-status-${p.status}`} title={(p.queued ?? 0) > 0 ? `${p.queued} action(s) en attente de confirmation${p.detail === undefined ? "" : ` · ${p.detail}`}` : p.detail}>
      {STATUS_LABEL[p.status]}
      <Show when={lasting() && (p.queued ?? 0) > 0}> · {p.queued} en attente</Show>
    </span>
  );
}

/** Phase in words, for the control room and the host (same wording everywhere). */
export const PHASE_LABEL: Record<Phase, string> = {
  lobby: "Avant la partie",
  idle: "Entre deux questions",
  presenting: "Question présentée",
  open: "Réponses ouvertes",
  locked: "Réponses fermées",
  judging: "Validation",
  revealed: "Réponse révélée",
  "round.end": "Fin de manche",
  "game.end": "Fin de partie",
};

/** Discreet link back to the home page (`/`, apps/hub). */
export function HomeLink(): JSX.Element {
  return <a class="q-homelink" href="/" title="Accueil : tous les postes et liens du show">Accueil</a>;
}

/**
 * Key for a destructive step on a touch screen: the first tap arms it (amber, « Confirmer ? »), the second tap
 * within 4 s sends it. No modal dialog to dismiss in the middle of a live show.
 */
export function ConfirmKey(p: { readonly label: string; readonly confirmLabel?: string; readonly onConfirm: () => void; readonly disabled?: boolean; readonly class?: string }): JSX.Element {
  const [armed, setArmed] = createSignal(false);
  let t: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(t));
  const tap = () => {
    clearTimeout(t);
    if (armed()) {
      setArmed(false);
      p.onConfirm();
      return;
    }
    setArmed(true);
    t = setTimeout(() => setArmed(false), 4000);
  };
  return (
    <button type="button" class={`q-btn q-btn-secondary q-confirm ${p.class ?? ""}`} data-armed={String(armed())} disabled={p.disabled} onClick={tap}>
      {armed() ? (p.confirmLabel ?? `Confirmer : ${p.label.toLowerCase()} ?`) : p.label}
    </button>
  );
}

/** Mechanic ids in words (run-downs). Unknown ids are shown as is. */
export const MECHANIC_LABEL: Readonly<Record<string, string>> = {
  mixed: "Mixte",
  choice: "QCM",
  buzzer: "Buzzer",
  ladder: "Paliers",
  "poll-board": "Sondage",
  "text-answer": "Réponse libre",
  "number-answer": "Estimation",
  order: "Ordre",
  pairs: "Associations",
  pin: "Point sur image",
  allocation: "Répartition",
  board: "Plateau",
  hints: "Indices",
  "reveal-image": "Image dévoilée",
};
