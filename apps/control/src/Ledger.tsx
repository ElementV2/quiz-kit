import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import type { Action, ControlView } from "@quiz/schema";
import { Button, confirmDialog } from "@quiz/ui";
import { ledgerRows } from "./logic.ts";

const PAGE = 50;

/**
 * « Historique des points »: every line of points (who, how many, why, which question), newest first; a line can
 * be cancelled (`score.void`, undoable like any action). Cancelled lines stay, struck through.
 */
export function LedgerPanel(p: { readonly view: ControlView; readonly readonly: boolean; readonly act: (a: Action, ok?: string) => Promise<boolean> }): JSX.Element {
  const rows = createMemo(() => ledgerRows(p.view));
  const [shown, setShown] = createSignal(PAGE);
  const cancel = async (id: string, who: string, delta: number) => {
    const ok = await confirmDialog({ title: "Annuler cette ligne de points ?", message: `${who} : ${delta > 0 ? "+" : ""}${delta}. Le total est recalculé (Ctrl+Z pour revenir).`, confirm: "Annuler la ligne", danger: true });
    if (ok) await p.act({ type: "score.void", entryId: id }, "ligne annulée");
  };
  return (
    <Show when={rows().length > 0} fallback={<p class="muted">Aucun point donné pour l'instant.</p>}>
      <ol class="c-ledger">
        <For each={rows().slice(0, shown())}>
          {(r) => (
            <li data-voided={String(r.voided)}>
              <span class="q-mono muted">{new Date(r.at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
              <b>{r.who}</b>
              <span class="q-mono c-ledger-delta" data-sign={r.delta >= 0 ? "plus" : "minus"}>{r.delta > 0 ? "+" : ""}{r.delta}</span>
              <span class="muted">{r.why}{r.question === null ? "" : ` · ${r.question}`}{r.voided ? " · annulée" : ""}</span>
              <Show when={!p.readonly && !r.voided}><Button kind="ghost" title="Annuler cette ligne" onClick={() => void cancel(r.id, r.who, r.delta)}>Annuler</Button></Show>
            </li>
          )}
        </For>
      </ol>
      <Show when={rows().length > shown()}><Button kind="ghost" onClick={() => setShown(shown() + PAGE)}>Voir plus ({rows().length - shown()} autres)</Button></Show>
    </Show>
  );
}
