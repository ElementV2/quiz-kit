import { Show, createMemo } from "solid-js";
import { render } from "solid-js/web";
import { DEFAULT_THEME, OUTPUT_SCENES, PROGRAM_SCENE } from "@quiz/schema";
import { SceneRenderer } from "@quiz/renderer";
import { createQuizConnection } from "@quiz/ui";

/** /out/<scene>?t=… — 1920×1080, transparent, read-only. A reload gets the exact state from the welcome snapshot. */
function Output() {
  const conn = createQuizConnection({ persist: false, preview: new URLSearchParams(location.search).get("preview") === "1" });
  const sceneId = createMemo(() => {
    const v = conn.viewer();
    if (v?.role === "output") return v.scene;
    return location.pathname.split("/").filter(Boolean).at(-1) ?? "program";
  });
  const scene = () => OUTPUT_SCENES[sceneId()] ?? PROGRAM_SCENE;
  return (
    <>
      <SceneRenderer scene={scene()} theme={DEFAULT_THEME} view={conn.view()} serverNow={conn.serverNow} />
      {/* Operator hint, only while disconnected: never shown on air once connected. */}
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
