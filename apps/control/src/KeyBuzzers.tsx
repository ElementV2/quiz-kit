import { For, Show, createSignal, type JSX } from "solid-js";
import type { Action, ControlView } from "@quiz/schema";
import { Button } from "@quiz/ui";
import { DEFAULT_BUZZER_KEYS, assignBuzzerKey, buzzerKey, keyLabel, keyOfSeat, parseBuzzerKeys, type BuzzerKeyMap } from "./logic.ts";

/**
 * « Buzzers clavier » (doc 08, docs/api/control.md): USB HID buzzer boxes type keys; once the operator ARMS
 * the mode, each mapped key sends `buzz` for the player at that seat. The order of arrival at the server is the
 * journal order = who has the hand. Mapping kept per browser (localStorage).
 */

const STORAGE_KEY = "quiz.control.buzzerKeys";
type Act = (a: Action, ok?: string) => Promise<boolean>;
export type BuzzLog = { readonly at: string; readonly seat: number; readonly name: string; readonly result: string };

const load = (): BuzzerKeyMap => {
  try {
    return parseBuzzerKeys(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_BUZZER_KEYS;
  }
};
const save = (m: BuzzerKeyMap) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(m));
  } catch {
    /* private mode: mapping for this page only */
  }
};

const clock = (): string => {
  const d = new Date();
  return `${d.toLocaleTimeString("fr-FR", { hour12: false })}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

export type KeyBuzzers = ReturnType<typeof createKeyBuzzers>;

export function createKeyBuzzers(view: () => ControlView | null, act: Act) {
  const [armed, setArmed] = createSignal(false);
  const [map, setMapRaw] = createSignal<BuzzerKeyMap>(load());
  const [learning, setLearning] = createSignal<number | null>(null);
  const [log, setLog] = createSignal<readonly BuzzLog[]>([]);
  const setMap = (m: BuzzerKeyMap) => {
    setMapRaw(m);
    save(m);
  };
  const push = (entry: BuzzLog) => setLog([entry, ...log()].slice(0, 8));
  /**
   * Window keydown hook, called before every other shortcut. Returns true when the key was a buzzer key
   * (then nothing else may react to it, not even the space bar's « next step »).
   */
  const handle = (e: KeyboardEvent): boolean => {
    const seatToLearn = learning();
    if (seatToLearn !== null) {
      e.preventDefault();
      if (e.key !== "Escape") setMap(assignBuzzerKey(map(), seatToLearn, e.key));
      setLearning(null);
      return true;
    }
    if (!armed()) return false;
    const seat = map()[buzzerKey(e.key)];
    if (seat === undefined) return false;
    e.preventDefault();
    if (e.repeat) return true;
    const v = view();
    const player = v?.participants.find((p) => p.seat === seat) ?? null;
    const at = clock();
    if (player === null) {
      push({ at, seat, name: "—", result: "siège libre" });
      return true;
    }
    void act({ type: "buzz", participantId: player.id }).then((ok) => push({ at, seat, name: player.displayName, result: ok ? "buzz" : "refusé" }));
    return true;
  };
  return { armed, setArmed, map, setMap, learning, setLearning, log, handle };
}

export function KeyBuzzersPanel(p: { readonly kb: KeyBuzzers; readonly view: ControlView }): JSX.Element {
  const seats = () => {
    const max = Math.max(9, ...p.view.participants.map((x) => x.seat ?? 0), ...Object.values(p.kb.map()));
    return Array.from({ length: max }, (_, i) => i + 1);
  };
  const who = (seat: number) => p.view.participants.find((x) => x.seat === seat)?.displayName ?? null;
  return (
    <div class="c-stack">
      <div class="c-row c-row-tight">
        <button type="button" class="q-switch" role="switch" aria-checked={p.kb.armed()} onClick={() => p.kb.setArmed(!p.kb.armed())}>
          {p.kb.armed() ? "Buzzers armés" : "Armer les buzzers clavier"}
        </button>
        <span class="muted">Touches actives même hors de cet onglet.</span>
      </div>
      <Show when={p.kb.armed()}><p class="c-warn">Armés : les touches associées buzzent (Espace aussi si associée). Désarmer avant de taper ailleurs.</p></Show>
      <table class="c-table">
        <thead><tr><th>Siège</th><th>Joueur</th><th>Touche</th><th /></tr></thead>
        <tbody>
          <For each={seats()}>
            {(seat) => (
              <tr>
                <td class="q-mono">{seat}</td>
                <td>{who(seat) ?? <span class="muted">libre</span>}</td>
                <td><Show when={keyOfSeat(p.kb.map(), seat)} fallback={<span class="muted">—</span>}>{(k) => <kbd>{keyLabel(k())}</kbd>}</Show></td>
                <td class="c-right-cell">
                  <Button kind="ghost" onClick={() => p.kb.setLearning(p.kb.learning() === seat ? null : seat)}>{p.kb.learning() === seat ? "Appuyez sur le buzzer…" : "Associer"}</Button>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
      <div class="c-row c-row-tight">
        <Button kind="secondary" onClick={() => p.kb.setMap(DEFAULT_BUZZER_KEYS)}>Par défaut (1 à 9)</Button>
        <Button kind="ghost" onClick={() => p.kb.setMap({})}>Tout effacer</Button>
      </div>
      <Show when={p.kb.log().length > 0}>
        <span class="q-label">Derniers buzz</span>
        <ul class="c-log">
          <For each={p.kb.log()}>{(l) => <li><span class="q-mono">{l.at}</span> <span class="q-mono">S{l.seat}</span> {l.name} <span class={l.result === "buzz" ? "c-ok" : "c-err"}>{l.result}</span></li>}</For>
        </ul>
      </Show>
    </div>
  );
}
