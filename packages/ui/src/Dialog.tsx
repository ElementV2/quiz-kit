import { Show, createSignal } from "solid-js";
import { render } from "solid-js/web";

/**
 * The app's own confirmation / copy dialogs (never the browser's `confirm` / `prompt`, which look foreign and
 * show the page address). Built on `<dialog>` + `showModal()`: focus stays inside, Échap cancels, Entrée confirms.
 * One dialog at a time; `isDialogOpen()` lets global shortcuts (space bar, studio keys) stand aside meanwhile.
 */

export type ConfirmOptions = {
  readonly title: string;
  readonly message?: string;
  /** Label of the confirm key (default « Confirmer »). */
  readonly confirm?: string;
  /** Label of the cancel key (default « Annuler »). */
  readonly cancel?: string;
  /** Destructive / irreversible action: red confirm key. */
  readonly danger?: boolean;
};

type Pending =
  | { readonly kind: "confirm"; readonly opts: ConfirmOptions; readonly resolve: (ok: boolean) => void }
  | { readonly kind: "copy"; readonly title: string; readonly text: string; readonly resolve: (ok: boolean) => void };

const [pending, setPending] = createSignal<Pending | null>(null);
let mounted = false;

/** True while one of our dialogs is open (global keyboard shortcuts must ignore keys then). */
export const isDialogOpen = (): boolean => pending() !== null;

function DialogHost() {
  let el: HTMLDialogElement | undefined;
  let input: HTMLInputElement | undefined;
  const close = (ok: boolean) => {
    const p = pending();
    if (p === null) return;
    setPending(null);
    el?.close();
    p.resolve(ok);
  };
  const open = (node: HTMLDialogElement) => {
    el = node;
    // Opened as soon as there is something to show; Échap → `cancel` event → resolves false.
    node.addEventListener("cancel", (e) => {
      e.preventDefault();
      close(false);
    });
  };
  return (
    <dialog ref={open} class="q-dialog" aria-labelledby="q-dialog-title">
      <Show when={pending()}>
        {(p) => {
          queueMicrotask(() => {
            if (el !== undefined && !el.open) el.showModal();
            input?.select();
          });
          const cur = p();
          return cur.kind === "confirm" ? (
            <form method="dialog" class="q-dialog-body" onSubmit={(e) => { e.preventDefault(); close(true); }}>
              <h2 id="q-dialog-title" class="q-dialog-title">{cur.opts.title}</h2>
              <Show when={cur.opts.message}>{(m) => <p class="q-dialog-message">{m()}</p>}</Show>
              <div class="q-dialog-keys">
                <button type="button" class="q-btn q-btn-secondary" onClick={() => close(false)}>{cur.opts.cancel ?? "Annuler"}</button>
                <button type="submit" class={`q-btn ${cur.opts.danger === true ? "q-btn-danger q-dialog-danger" : ""}`} autofocus>{cur.opts.confirm ?? "Confirmer"}</button>
              </div>
            </form>
          ) : (
            <form method="dialog" class="q-dialog-body" onSubmit={(e) => { e.preventDefault(); close(true); }}>
              <h2 id="q-dialog-title" class="q-dialog-title">{cur.title}</h2>
              <p class="q-dialog-message">La copie automatique n'est pas disponible ici : sélectionner le texte puis Ctrl+C.</p>
              <input ref={input} class="q-dialog-copy q-mono" readOnly value={cur.text} onFocus={(e) => e.currentTarget.select()} />
              <div class="q-dialog-keys">
                <button type="submit" class="q-btn" autofocus>Fermer</button>
              </div>
            </form>
          );
        }}
      </Show>
    </dialog>
  );
}

function ensureHost(): void {
  if (mounted || typeof document === "undefined") return;
  mounted = true;
  const root = document.createElement("div");
  root.dataset["qDialogRoot"] = "";
  document.body.append(root);
  render(() => <DialogHost />, root);
}

/** Asks for confirmation in the app's own dialog. Resolves true when confirmed, false when cancelled. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  ensureHost();
  return new Promise((resolve) => {
    pending()?.resolve(false); // a newer question replaces an unanswered one
    setPending({ kind: "confirm", opts, resolve });
  });
}

/** Shows a text to copy by hand (when the clipboard API is unavailable: plain HTTP on a LAN IP). */
export function copyDialog(title: string, text: string): Promise<boolean> {
  ensureHost();
  return new Promise((resolve) => {
    pending()?.resolve(false);
    setPending({ kind: "copy", title, text, resolve });
  });
}
