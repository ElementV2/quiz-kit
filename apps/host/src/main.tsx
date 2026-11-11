import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { render } from "solid-js/web";
import type { HostView } from "@quiz/schema";
import { asChoice, optionLetter, secondsLeft } from "@quiz/renderer";
import { Panel, StatusPill, createQuizConnection } from "@quiz/ui";
import "@quiz/ui/ui.css";
import "./host.css";

/** /host — question, correct answer, notes, next question (doc 08). Never on air. */
function App() {
  const conn = createQuizConnection();
  const view = createMemo<HostView | null>(() => {
    const v = conn.view();
    return v !== null && v.role === "host" ? v : null;
  });
  const [now, setNow] = createSignal(conn.serverNow());
  const t = setInterval(() => setNow(conn.serverNow()), 250);
  onCleanup(() => clearInterval(t));
  return (
    <div class="h-app">
      <header class="h-top">
        <h1>Animateur</h1>
        <StatusPill status={conn.status()} detail={conn.statusDetail()} />
      </header>
      <Show when={view()} fallback={<p class="muted">Connexion…</p>}>
        {(v) => (
          <>
            <div class="h-meta">
              <span>{v().round?.title ?? "Avant la partie"}</span>
              <Show when={v().question}>{(q) => <span>Question {q().index + 1} / {q().count}</span>}</Show>
              <Show when={v().timer}>{(tm) => <span class="h-timer">⏱ {secondsLeft(tm().endsAt, now())} s</span>}</Show>
            </div>
            <Show when={v().question} fallback={<Panel><p class="h-prompt">En attente de la prochaine question…</p></Panel>}>
              {(q) => (
                <Panel>
                  <p class="h-prompt">{q().prompt.text}</p>
                </Panel>
              )}
            </Show>
            <Show when={asChoice(v().mechanic)}>
              {(mm) => {
                const m = () => mm();
                const answer = () => m()?.options.filter((o) => m()?.correct?.includes(o.id) === true).map((o) => o.label).join(" + ") ?? "";
                return (
                  <>
                    <p class="h-answer">Bonne réponse : {answer()}</p>
                    <div class="h-opts">
                      <For each={m()?.options ?? []}>
                        {(o, i) => (
                          <div class="h-opt" data-correct={String(m()?.correct?.includes(o.id) === true)}>
                            <b>{optionLetter(i())}</b> {o.label}
                            <span class="h-count">{m()?.counts?.[o.id] ?? ""}</span>
                          </div>
                        )}
                      </For>
                    </div>
                    <p class="muted">{m()?.answeredCount ?? 0} réponse(s) reçue(s)</p>
                  </>
                );
              }}
            </Show>
            <Show when={v().notes}>{(n) => <p class="h-notes">📝 {n()}</p>}</Show>
            <Show when={v().nextQuestion}>{(nq) => <p class="h-next">Ensuite : {nq().text}</p>}</Show>
          </>
        )}
      </Show>
    </div>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <App />, root);
