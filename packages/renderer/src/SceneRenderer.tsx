import { For, Show, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Dynamic } from "solid-js/web";
import type { Layer, Scene, Theme, View, Zone } from "@quiz/schema";
import { layerVisible, themeVars } from "./logic.ts";
import { zoneComponent, type ZoneProps } from "./zones.tsx";

export type SceneRendererProps = {
  readonly scene: Scene;
  readonly theme: Theme;
  readonly view: View | null;
  /** Server time estimate (protocol client), for countdowns. */
  readonly serverNow: () => number;
  /** Fit the fixed canvas into the parent (control preview). Outputs render 1:1. */
  readonly fit?: boolean;
  /** Draw zone outlines (studio / debug). */
  readonly outline?: boolean;
  /** Resolves a media hash to a URL (preloaded blob). Default: `/media/<hash>`. */
  readonly mediaUrl?: (hash: string) => string;
};

/**
 * Renders one scene for one projected view (doc 06). Same component for outputs, control preview and studio:
 * what is seen in the studio is what goes on air. Background stays transparent (OBS / vMix alpha).
 */
export function SceneRenderer(props: SceneRendererProps): JSX.Element {
  const [scale, setScale] = createSignal(1);
  let host: HTMLDivElement | undefined;
  onMount(() => {
    if (props.fit !== true || host === undefined) return;
    const parent = host.parentElement;
    if (parent === null) return;
    const ro = new ResizeObserver(() => setScale(Math.min(parent.clientWidth / props.scene.size.w, parent.clientHeight / props.scene.size.h)));
    ro.observe(parent);
    onCleanup(() => ro.disconnect());
  });
  const layers = createMemo(() => props.scene.layers.toSorted((a, b) => a.z - b.z));
  const taken = createMemo<Readonly<Record<string, boolean>>>(() => (props.view !== null && "layers" in props.view ? (props.view as { layers?: Record<string, boolean> }).layers ?? {} : {})); // oxlint-disable-line typescript/no-unsafe-type-assertion -- optional field until layer TAKE/OUT lands in the view schema
  const style = (): JSX.CSSProperties => ({
    ...themeVars(props.theme),
    position: "relative",
    width: `${props.scene.size.w}px`,
    height: `${props.scene.size.h}px`,
    overflow: "hidden",
    "font-family": "var(--q-font)",
    "font-weight": "var(--q-font-weight)",
    color: "var(--q-color-text)",
    "transform-origin": "0 0",
    transform: props.fit === true ? `scale(${scale()})` : "none",
  });
  return (
    <div ref={host} class="q-scene" data-scene={props.scene.id} style={style()}>
      <Show when={props.view}>
        {(view) => (
          <For each={layers()}>
            {(layer: Layer) => (
              <div
                class="q-layer"
                data-layer={layer.id}
                data-visible={String(layerVisible(layer, view().phase, taken()))}
                style={{
                  position: "absolute",
                  inset: "0",
                  "z-index": layer.z,
                  opacity: layerVisible(layer, view().phase, taken()) ? 1 : 0,
                  transition: "opacity var(--q-motion) ease",
                  "pointer-events": "none",
                }}
              >
                <For each={layer.zones}>{(zone: Zone) => <ZoneBox zone={zone} view={view()} serverNow={props.serverNow} mediaUrl={props.mediaUrl ?? defaultMediaUrl} outline={props.outline === true} />}</For>
              </div>
            )}
          </For>
        )}
      </Show>
    </div>
  );
}

const defaultMediaUrl = (hash: string): string => `/media/${hash}`;

function ZoneBox(p: ZoneProps & { readonly outline: boolean }): JSX.Element {
  return (
    <div
      class={`q-zone q-zone-${p.zone.type}`}
      data-zone={p.zone.id}
      style={{
        position: "absolute",
        left: `${p.zone.rect.x}px`,
        top: `${p.zone.rect.y}px`,
        width: `${p.zone.rect.w}px`,
        height: `${p.zone.rect.h}px`,
        outline: p.outline ? "2px dashed rgba(255,255,255,.35)" : "none",
        ...p.zone.style,
      }}
    >
      <Dynamic component={zoneComponent(p.zone.type)} zone={p.zone} view={p.view} serverNow={p.serverNow} mediaUrl={p.mediaUrl} />
    </div>
  );
}
