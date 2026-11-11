import { Show, createMemo, createResource } from "solid-js";
import { render } from "solid-js/web";
import { DEFAULT_THEME, OUTPUT_SCENES, PROGRAM_SCENE, Scene, Theme } from "@quiz/schema";
import { SceneRenderer, parseEffectsLevel } from "@quiz/renderer";
import { createQuizConnection, tokenFromUrl } from "@quiz/ui";

type Presentation = { theme: Theme | null; scenes: Scene[] };

/** Theme + scenes of the current game, validated (boundary). Falls back to the built-in presets. */
async function fetchPresentation(): Promise<Presentation> {
  try {
    const res = await fetch(`/api/presentation?t=${encodeURIComponent(tokenFromUrl())}`);
    if (!res.ok) return { theme: null, scenes: [] };
    const raw: unknown = await res.json();
    if (typeof raw !== "object" || raw === null) return { theme: null, scenes: [] };
    const theme = "theme" in raw ? Theme.safeParse(raw.theme) : null;
    const scenes = "scenes" in raw && Array.isArray(raw.scenes) ? raw.scenes.flatMap((s: unknown) => { const r = Scene.safeParse(s); return r.success ? [r.data] : []; }) : [];
    return { theme: theme?.success === true ? theme.data : null, scenes };
  } catch {
    return { theme: null, scenes: [] };
  }
}

/** /out/<scene>?t=… — 1920×1080, transparent, read-only. A reload gets the exact state from the welcome snapshot. */
const params = new URLSearchParams(location.search);
/** `?fx=full|light|off` (default light until the OBS / vMix bench), `?bench=1` shows fps and keeps emitting. */
const effects = parseEffectsLevel(params.get("fx"));
const bench = params.get("bench") === "1";
const preview = params.get("preview") === "1";

function Output() {
  const conn = createQuizConnection({ persist: false, preview: new URLSearchParams(location.search).get("preview") === "1" });
  // Refetch the look whenever the game changes (session id in the view).
  const [presentation] = createResource(() => conn.view()?.sessionId, fetchPresentation);
  const sceneId = createMemo(() => {
    const v = conn.viewer();
    if (v?.role === "output") return v.scene;
    return location.pathname.split("/").filter(Boolean).at(-1) ?? "program";
  });
  const scene = () => presentation()?.scenes.find((s) => s.id === sceneId()) ?? OUTPUT_SCENES[sceneId()] ?? PROGRAM_SCENE;
  const theme = () => presentation()?.theme ?? DEFAULT_THEME;
  return (
    <>
      <SceneRenderer scene={scene()} theme={theme()} view={conn.view()} serverNow={conn.serverNow} mediaUrl={conn.mediaUrl} effects={preview ? "off" : effects} bench={bench} />
      {/* Operator hint, only while the link is refused: never shown on air once connected. */}
      <Show when={conn.status() === "rejected"}>
        <div style={{ position: "fixed", left: "20px", bottom: "20px", padding: "10px 16px", background: "#7f1d1d", color: "#fff", font: "600 20px system-ui", "border-radius": "10px" }}>
          Lien refusé ({conn.statusDetail()}) — recopier le lien depuis la régie
        </div>
      </Show>
    </>
  );
}

const root = document.getElementById("root");
if (root !== null) render(() => <Output />, root);
