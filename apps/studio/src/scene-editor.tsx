import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { DEFAULT_THEME, GameDocument, OUTPUT_SCENES, ZoneState, ZoneType, type Layer, type Scene, type Theme, type Zone } from "@quiz/schema";
import { SceneRenderer, layerVisible } from "@quiz/renderer";
import { Button, confirmDialog, isDialogOpen } from "@quiz/ui";
import { api, download, imageSize, mediaUrl, svgToPng } from "./api.ts";
import { HANDLES, ZONE_CODE, bandRect, fitScale, intersects, keepInside, moveRects, overflows, removeZones, resizeFrom, toggleRef, type Handle, type Rect, type ZoneRef } from "./canvas-logic.ts";
import { alignRects, assetSheetHtml, distributeRects, duplicateZone, freeId, pickColor, psdTemplateLayers, rectFromDrag, sceneIds, zonesFromPsd } from "./design-import.ts";
import { JsonField } from "./fields.tsx";
import { SAFE_AREAS, SIMULATED_PHASES, assetSheet, assetSheetCsv, deriveStates, longestText, matchDeliveredAssets, outsideSafe, simulateView, snap, templateSvg, type SimulatedPhase } from "./studio-logic.ts";
import { hex, inField, snapshot, type Update } from "./util.ts";

/** Zone types in words (menus of the scene editor). */
const ZONE_LABEL: Record<ZoneType, string> = {
  "question": "Question",
  "question-media": "Média de la question",
  "answer-list": "Liste des réponses",
  "poll-board": "Tableau du sondage",
  "buzzer": "Buzzer (qui a la main)",
  "ladder": "Échelle de gains",
  "timer": "Chrono",
  "leaderboard": "Classement",
  "round-info": "Manche et numéro de question",
  "answer-count": "Nombre de réponses",
  "text": "Texte",
  "image": "Image",
  "board-grid": "Grille du plateau",
};

/** What a text zone can show, in words (the bound value is read from the live view). */
const TEXT_SOURCES: readonly (readonly [string, string])[] = [
  ["", "Texte fixe (écrit ci-dessous)"],
  ["round.title", "Titre de la manche en cours"],
  ["question.prompt.text", "Texte de la question à l'antenne"],
];

/** « Texte affiché » of a text zone: a fixed text, or a live value (round title…). */
function TextSource(p: { readonly zone: Zone; readonly edit: (f: (z: Zone) => void, key?: string) => void }): JSX.Element {
  const known = () => TEXT_SOURCES.some(([v]) => v === (p.zone.bind ?? ""));
  return (
    <>
      <label class="s-field"><span class="s-label">Texte affiché</span>
        <select value={known() ? (p.zone.bind ?? "") : "other"} onChange={(e) => { const v = e.currentTarget.value; if (v !== "other") p.edit((z) => { if (v === "") delete z.bind; else z.bind = v; }); }}>
          <For each={TEXT_SOURCES}>{([v, label]) => <option value={v}>{label}</option>}</For>
          <Show when={!known()}><option value="other">Autre donnée : {p.zone.bind}</option></Show>
        </select>
      </label>
      <Show when={p.zone.bind === undefined}>
        <label class="s-field"><span class="s-label">Texte</span><input value={typeof p.zone.props["text"] === "string" ? p.zone.props["text"] : ""} placeholder="ex. Grande finale" onInput={(e) => { const v = e.currentTarget.value; p.edit((z) => { z.props["text"] = v; }, "ztext"); }} /></label>
      </Show>
      <Show when={p.zone.bind === "round.title"}><p class="muted s-hint">Le titre se règle dans Format (nom de chaque manche) ; entre deux parties, rien ne s'affiche.</p></Show>
    </>
  );
}

/** The scenes a game without its own uses (programme, classement, mur). */
const BUILT_IN_SCENES: readonly Scene[] = Object.values(OUTPUT_SCENES);

const PHASE_LABEL: Record<SimulatedPhase, string> = { idle: "Entre deux questions", presenting: "Question présentée", open: "Réponses ouvertes", locked: "Réponses fermées", revealed: "Réponse révélée", "game.end": "Fin de partie" };
export const COLOR_LABELS: Record<keyof Theme["colors"], string> = { surface: "Fond des cadres", surfaceAlt: "Fond secondaire", text: "Texte", muted: "Texte secondaire", primary: "Primaire", accent: "Accent", correct: "Bonne réponse", wrong: "Mauvaise réponse", selected: "Sélection" };
const PHASES_ALL = ["lobby", "idle", "presenting", "open", "locked", "judging", "revealed", "round.end", "game.end"] as const;
const PHASE_SHORT: Record<(typeof PHASES_ALL)[number], string> = { lobby: "accueil", idle: "attente", presenting: "présentée", open: "ouverte", locked: "fermée", judging: "jugement", revealed: "révélée", "round.end": "fin de manche", "game.end": "fin de partie" };
const ALIGN = [["left", "Gauche"], ["center-h", "Centre H"], ["right", "Droite"], ["top", "Haut"], ["center-v", "Centre V"], ["bottom", "Bas"]] as const;

const SHORTCUTS: readonly (readonly [string, string])[] = [
  ["Clic", "sélectionner une zone"],
  ["Maj + clic", "ajouter / retirer de la sélection"],
  ["Glisser sur le vide", "sélection au lasso"],
  ["Suppr ou Retour arrière", "supprimer la sélection"],
  ["Flèches", "déplacer de 1 px (Maj : 10 px)"],
  ["Ctrl + D", "dupliquer"],
  ["Ctrl + A", "tout sélectionner"],
  ["Ctrl + Z / Ctrl + Y", "annuler / rétablir"],
  ["Échap", "désélectionner, quitter l'outil"],
  ["V · T · I", "outils sélection · tracer · pipette"],
];

type Tool = "select" | "trace" | "pick";
type Zoom = "fit" | 0.5 | 1;

const refKey = (r: ZoneRef): string => `${r.layer}:${r.zone}`;

function EyeIcon(p: { off: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path d="M1 8s2.5-5 7-5 7 5 7 5-2.5 5-7 5-7-5-7-5z" fill="none" stroke="currentColor" stroke-width="1.3" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
      <Show when={p.off}><path d="M2 14L14 2" stroke="currentColor" stroke-width="1.5" /></Show>
    </svg>
  );
}

function LockIcon(p: { on: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <rect x="3" y="7" width="10" height="7" fill={p.on ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.3" />
      <path d={p.on ? "M5 7V5a3 3 0 0 1 6 0v2" : "M5 7V5a3 3 0 0 1 6 0"} fill="none" stroke="currentColor" stroke-width="1.3" />
    </svg>
  );
}

const toggleSet = (set: ReadonlySet<string>, k: string): Set<string> => {
  const n = new Set(set);
  if (n.has(k)) n.delete(k);
  else n.add(k);
  return n;
};

/** Follows a pointer drag on the window until release. */
const onPointer = (move: (ev: PointerEvent) => void, up: (ev: PointerEvent) => void) => {
  const m = (ev: PointerEvent) => move(ev);
  const u = (ev: PointerEvent) => {
    window.removeEventListener("pointermove", m);
    window.removeEventListener("pointerup", u);
    up(ev);
  };
  window.addEventListener("pointermove", m);
  window.addEventListener("pointerup", u);
};


export function SceneEditor(p: { doc: GameDocument; update: Update }): JSX.Element {
  const [sceneIdx, setSceneIdx] = createSignal(0);
  const [phase, setPhase] = createSignal<SimulatedPhase>("revealed");
  const [qIndex, setQIndex] = createSignal(0);
  /** Selected zones; the first one is the reference for alignment. */
  const [sel, setSel] = createSignal<ZoneRef[]>([]);
  const [layerSel, setLayerSel] = createSignal<number | null>(null);
  const [hiddenLayers, setHiddenLayers] = createSignal<ReadonlySet<string>>(new Set());
  const [locked, setLocked] = createSignal<ReadonlySet<string>>(new Set());
  const [refHash, setRefHash] = createSignal<string | null>(null);
  const [refOpacity, setRefOpacity] = createSignal(0.5);
  const [report, setReport] = createSignal<string | null>(null);
  const [fit, setFit] = createSignal(0.5);
  const [zoom, setZoom] = createSignal<Zoom>("fit");
  const scale = () => {
    const z = zoom();
    return z === "fit" ? fit() : z;
  };
  const [tool, setTool] = createSignal<Tool>("select");
  const [traceType, setTraceType] = createSignal<Zone["type"]>("text");
  const [tracing, setTracing] = createSignal<Rect | null>(null);
  const [band, setBand] = createSignal<Rect | null>(null);
  const [picked, setPicked] = createSignal<string | null>(null);
  const [help, setHelp] = createSignal(false);
  const [psdInfo, setPsdInfo] = createSignal<{ fonts: { name: string; size: number | null; layer: string }[]; colors: string[] } | null>(null);

  // A game without its own scenes shows the built-in ones; the first edit copies them into the game.
  const scenes = (): readonly Scene[] => (p.doc.scenes.length > 0 ? p.doc.scenes : BUILT_IN_SCENES);
  const scene = (): Scene | undefined => scenes()[sceneIdx()];
  const size = () => scene()?.size ?? { w: 1920, h: 1080 };
  const zoneAt = (r: ZoneRef): Zone | undefined => scene()?.layers[r.layer]?.zones[r.zone];
  const isSel = (r: ZoneRef) => sel().some((s) => s.layer === r.layer && s.zone === r.zone);
  const layerLocked = (l: Layer) => locked().has(l.id);
  const zoneLocked = (l: Layer, z: Zone) => layerLocked(l) || locked().has(`${l.id}/${z.id}`);
  const editScene = (f: (s: Scene) => void, key?: string) => p.update((d) => {
    if (d.scenes.length === 0) d.scenes = BUILT_IN_SCENES.map((x) => structuredClone(x));
    const sc = d.scenes[sceneIdx()];
    if (sc !== undefined) f(sc);
  }, key);

  // Reference layer pixels for the eyedropper.
  let refPixels: ImageData | null = null;
  createEffect(() => {
    const h = refHash();
    refPixels = null;
    if (h === null) return;
    const img = new Image();
    img.src = mediaUrl(h);
    void img.decode().then(() => {
      const c = document.createElement("canvas");
      c.width = 1920;
      c.height = 1080;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx?.drawImage(img, 0, 0, 1920, 1080);
      refPixels = ctx?.getImageData(0, 0, 1920, 1080) ?? null; // same origin (/media): canvas not tainted
    }).catch(() => undefined);
  });

  let stage: HTMLDivElement | undefined;
  const toStage = (e: PointerEvent): { x: number; y: number } => {
    const r = stage?.getBoundingClientRect();
    return r === undefined ? { x: 0, y: 0 } : { x: (e.clientX - r.left) / scale(), y: (e.clientY - r.top) / scale() };
  };
  let gesture = 0;
  /** Zones a rubber band / Ctrl+A may take: visible layer, on screen in the simulated phase, not locked. */
  const pickable = (): { ref: ZoneRef; z: Zone }[] =>
    (scene()?.layers ?? []).flatMap((l, li) => (hiddenLayers().has(l.id) || (!layerVisible(l, view()?.phase ?? "idle", {}) && previewed()?.id !== l.id) ? [] : l.zones.flatMap((z, zi) => (zoneLocked(l, z) ? [] : [{ ref: { layer: li, zone: zi }, z }]))));

  const onCanvasDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (tool() === "pick") {
      const pt = toStage(e);
      setPicked(refPixels === null ? null : pickColor(refPixels.data, refPixels.width, pt.x, pt.y));
      return;
    }
    e.preventDefault();
    const a = toStage(e);
    if (tool() === "trace") {
      onPointer((ev) => setTracing(rectFromDrag(a, toStage(ev), size(), 8)), (ev) => {
        setTracing(null);
        const r = rectFromDrag(a, toStage(ev), size(), 8);
        if (r !== null) addZone(traceType(), r);
      });
      return;
    }
    // Select tool on empty space: rubber band (a simple click deselects).
    const additive = e.shiftKey;
    onPointer((ev) => setBand(bandRect(a, toStage(ev))), (ev) => {
      setBand(null);
      const b = bandRect(a, toStage(ev));
      if (b.w * scale() < 4 && b.h * scale() < 4) {
        if (!additive) setSel([]);
        return;
      }
      const hit = pickable().filter((x) => intersects(b, x.z.rect)).map((x) => x.ref);
      setSel(additive ? [...sel(), ...hit.filter((h) => !isSel(h))] : hit);
      setLayerSel(null);
    });
  };

  const startMove = (e: PointerEvent, r: ZoneRef) => {
    if (tool() !== "select" || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    setLayerSel(null);
    if (e.shiftKey) {
      setSel(toggleRef(sel(), r));
      return;
    }
    if (!isSel(r)) setSel([r]);
    const refs = sel();
    const starts = refs.map((x) => zoneAt(x)?.rect).filter((x): x is Rect => x !== undefined);
    if (starts.length !== refs.length) return;
    const a = { x: e.clientX, y: e.clientY };
    const key = `drag-${++gesture}`;
    onPointer((ev) => {
      const dx = snap((ev.clientX - a.x) / scale());
      const dy = snap((ev.clientY - a.y) / scale());
      const moved = moveRects(starts, dx, dy, size());
      editScene((sc) => refs.forEach((x, i) => { const z = sc.layers[x.layer]?.zones[x.zone]; const m = moved[i]; if (z !== undefined && m !== undefined) z.rect = m; }), key);
    }, () => undefined);
  };

  const startResize = (e: PointerEvent, r: ZoneRef, handle: Handle) => {
    if (tool() !== "select") return;
    e.preventDefault();
    e.stopPropagation();
    const start = zoneAt(r)?.rect;
    if (start === undefined) return;
    const a = { x: e.clientX, y: e.clientY };
    const key = `resize-${++gesture}`;
    onPointer((ev) => {
      const next = resizeFrom(start, handle, (ev.clientX - a.x) / scale(), (ev.clientY - a.y) / scale(), size());
      editScene((sc) => { const z = sc.layers[r.layer]?.zones[r.zone]; if (z !== undefined) z.rect = next; }, key);
    }, () => undefined);
  };

  const deleteSelection = () => {
    const s = sel();
    if (s.length === 0) return;
    editScene((sc) => { removeZones(sc.layers, s); });
    setSel([]);
  };
  const duplicateSelection = () => {
    const s = sel();
    const sc0 = scene();
    if (s.length === 0 || sc0 === undefined) return;
    // Copies are built from a plain snapshot: structuredClone cannot clone the store proxies seen inside produce.
    const plain = snapshot(sc0);
    const taken = sceneIds(plain);
    const made = s.flatMap((r) => {
      const z = plain.layers[r.layer]?.zones[r.zone];
      if (z === undefined) return [];
      const copy = duplicateZone(z, taken, plain.size);
      taken.add(copy.id);
      return [{ layer: r.layer, zone: copy }];
    });
    const copies: ZoneRef[] = [];
    editScene((sc) => {
      for (const m of made) {
        const layer = sc.layers[m.layer];
        if (layer === undefined) continue;
        layer.zones.push(m.zone);
        copies.push({ layer: m.layer, zone: layer.zones.length - 1 });
      }
    });
    setSel(copies);
  };
  const nudge = (dx: number, dy: number) => {
    const s = sel();
    const starts = s.map((x) => zoneAt(x)?.rect).filter((x): x is Rect => x !== undefined);
    if (starts.length === 0 || starts.length !== s.length) return;
    const moved = moveRects(starts, dx, dy, size());
    editScene((sc) => s.forEach((x, i) => { const z = sc.layers[x.layer]?.zones[x.zone]; const m = moved[i]; if (z !== undefined && m !== undefined) z.rect = m; }), "nudge");
  };
  const overflowing = (): ZoneRef[] => (scene()?.layers ?? []).flatMap((l, li) => l.zones.flatMap((z, zi) => (overflows(z.rect, size()) ? [{ layer: li, zone: zi }] : [])));
  const fixOverflow = (refs: readonly ZoneRef[]) => editScene((sc) => refs.forEach((r) => { const z = sc.layers[r.layer]?.zones[r.zone]; if (z !== undefined) z.rect = keepInside(z.rect, sc.size); }));

  const onKey = (e: KeyboardEvent) => {
    if (isDialogOpen()) return; // our dialog owns the keyboard (Entrée / Échap)
    if (inField(e) || e.altKey) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (k === "Delete" || k === "Backspace") {
      if (sel().length > 0) {
        e.preventDefault();
        deleteSelection();
      }
      return;
    }
    const arrows: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const arrow = arrows[k];
    if (arrow !== undefined && !mod) {
      if (sel().length === 0) return;
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      nudge(arrow[0] * step, arrow[1] * step);
      return;
    }
    if (mod && k.toLowerCase() === "d") {
      e.preventDefault();
      duplicateSelection();
      return;
    }
    if (mod && k.toLowerCase() === "a") {
      e.preventDefault();
      setSel(pickable().map((x) => x.ref));
      return;
    }
    if (mod) return;
    if (k === "Escape") {
      if (help()) setHelp(false);
      else if (tool() !== "select") setTool("select");
      else {
        setSel([]);
        setLayerSel(null);
      }
      return;
    }
    if (k === "?") setHelp(!help());
    else if (k === "v" || k === "V") setTool("select");
    else if (k === "t" || k === "T") setTool("trace");
    else if ((k === "i" || k === "I") && refHash() !== null) setTool("pick");
  };
  onMount(() => window.addEventListener("keydown", onKey));
  onCleanup(() => window.removeEventListener("keydown", onKey));

  const arrange = (f: (rects: Rect[]) => Rect[]) => {
    const s = sel();
    const rects = s.map((x) => zoneAt(x)?.rect).filter((x): x is Rect => x !== undefined);
    if (rects.length !== s.length) return;
    const out = f(rects.map((r) => ({ ...r })));
    editScene((sc) => s.forEach((x, i) => { const z = sc.layers[x.layer]?.zones[x.zone]; const r = out[i]; if (z !== undefined && r !== undefined) z.rect = r; }));
  };

  const importPsd = async (f: File | undefined) => {
    if (f === undefined) return;
    setReport("Lecture du PSD…");
    try {
      const { readPsd } = await import("ag-psd");
      const psd = readPsd(await f.arrayBuffer(), { skipLayerImageData: true, skipThumbnail: true });
      const r = zonesFromPsd(psd.children ?? [], scene()?.size ?? { w: psd.width, h: psd.height });
      if (psd.canvas !== undefined) {
        const blob = await new Promise<Blob | null>((res) => psd.canvas?.toBlob(res, "image/png"));
        if (blob !== null) setRefHash((await api.upload(new File([blob], `${f.name}.png`, { type: "image/png" }))).hash);
      }
      editScene((target) => {
        if (r.zones.length === 0) return;
        const taken = sceneIds(target);
        let layer = target.layers.find((l) => l.id === "psd");
        if (layer === undefined) {
          layer = { id: "psd", name: "Import PSD", z: 10, mode: "auto", phases: [], zones: [] };
          target.layers.push(layer);
        }
        for (const z of r.zones) layer.zones.push(taken.has(z.id) ? { ...z, id: freeId(z.id, taken) } : z);
      });
      setPsdInfo({ fonts: r.fonts, colors: r.colors });
      setReport(`PSD ${psd.width}×${psd.height} : ${r.zones.length} zone(s) créée(s)${r.ignored.length > 0 ? ` · ignorés : ${r.ignored.join(", ")}` : ""}${psd.width !== 1920 || psd.height !== 1080 ? " · attention : le PSD n'est pas en 1920×1080" : ""}`);
    } catch (err) {
      setReport(`PSD illisible : ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const setThemeColor = (k: keyof Theme["colors"], c: string) => p.update((d) => {
    if (d.theme === undefined) d.theme = structuredClone(DEFAULT_THEME);
    d.theme.colors[k] = c;
  });
  const printSheet = () => {
    const sc = scene();
    const v = GameDocument.safeParse(snapshot(p.doc));
    if (sc === undefined || !v.success) return;
    const nine = (zone: string) => {
      const z = sc.layers.flatMap((l) => l.zones).find((x) => x.id === zone);
      const n = ["nineTop", "nineRight", "nineBottom", "nineLeft"].map((k) => Number(z?.props[k] ?? 0));
      return n.some((x) => x > 0) ? n.join(" / ") : "—";
    };
    const frame = document.createElement("iframe");
    frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0";
    frame.srcdoc = assetSheetHtml(sc, assetSheet(sc), nine, templateSvg(sc, v.data));
    frame.addEventListener("load", () => {
      frame.contentWindow?.print(); // the browser's « Enregistrer en PDF »
      setTimeout(() => frame.remove(), 60_000);
    }, { once: true });
    document.body.append(frame);
  };
  // The viewport is created inside <Show>: observe it when its ref is set (commit 7eaa8e6), fit width AND height.
  let ro: ResizeObserver | undefined;
  const setViewport = (el: HTMLDivElement) => {
    ro?.disconnect();
    ro = new ResizeObserver(() => setFit(fitScale({ w: el.clientWidth - 24, h: el.clientHeight - 24 }, size())));
    ro.observe(el);
  };
  onCleanup(() => ro?.disconnect());
  const view = createMemo(() => {
    const v = GameDocument.safeParse(snapshot(p.doc));
    return v.success ? simulateView(v.data, phase(), qIndex()) : null;
  });
  // The selected layer is always previewed on the canvas, even when the simulated phase or the control room (manual
  // layer, TAKE) would keep it off air: you see what you are editing.
  const previewed = (): Layer | undefined => scene()?.layers[layerSel() ?? sel()[0]?.layer ?? -1];
  const shownScene = createMemo((): Scene | undefined => {
    const sc = scene();
    if (sc === undefined) return sc;
    const hidden = hiddenLayers();
    const forced = previewed()?.id;
    return { ...sc, layers: sc.layers.filter((l) => !hidden.has(l.id)).map((l) => (l.id === forced ? { ...l, mode: "auto" as const, phases: [] } : l)) };
  });
  /** Why the previewed layer would not be on air in the simulated phase (said above the canvas). */
  const previewNote = createMemo((): string | null => {
    const l = previewed();
    if (l === undefined) return null;
    if (l.mode === "manual") return `Aperçu de « ${l.name} » : à l'antenne seulement quand la régie le lance (onglet Couches → TAKE).`;
    if (!layerVisible(l, view()?.phase ?? "idle", {})) return `Aperçu de « ${l.name} » : absent de l'écran dans la phase simulée, montré ici pour l'éditer.`;
    return null;
  });
  const addZone = (type: Zone["type"], rect: Rect = { x: 760, y: 440, w: 400, h: 200 }) => {
    const made: { ref: ZoneRef | null } = { ref: null };
    editScene((sc) => {
      if (sc.layers.length === 0) sc.layers.push({ id: "set", name: "Plateau", z: 10, mode: "auto", phases: [], zones: [] });
      const li = layerSel() ?? sel()[0]?.layer ?? 0;
      const layer = sc.layers[li] ?? sc.layers[0];
      if (layer === undefined) return;
      const taken = sceneIds(sc);
      layer.zones.push({ id: freeId(`${type}-${hex(2)}`, taken), type, rect, props: {}, style: {}, states: {} });
      made.ref = { layer: sc.layers.indexOf(layer), zone: layer.zones.length - 1 };
    });
    if (made.ref !== null) setSel([made.ref]);
    setTool("select");
  };
  const exportTemplate = async (kind: "svg" | "png" | "csv" | "psd") => {
    const sc = scene();
    const v = GameDocument.safeParse(snapshot(p.doc));
    if (sc === undefined || !v.success) return;
    const svg = templateSvg(sc, v.data);
    if (kind === "svg") download(`gabarit-${sc.id}.svg`, svg, "image/svg+xml");
    else if (kind === "csv") download(`assets-${sc.id}.csv`, assetSheetCsv(sc), "text/csv");
    else if (kind === "psd") download(`gabarit-${sc.id}.psd`, await templatePsd(sc, svg), "image/vnd.adobe.photoshop");
    else download(`gabarit-${sc.id}.png`, await svgToPng(svg, sc.size.w, sc.size.h));
  };
  const reimport = async (files: FileList | null) => {
    const sc = scene();
    if (files === null || sc === undefined) return;
    const list = await Promise.all([...files].map(async (f) => ({ f, ...(await imageSize(f).catch(() => ({ w: 0, h: 0 }))) })));
    const r = matchDeliveredAssets(sc, list.map((x) => ({ name: x.f.name, w: x.w, h: x.h })));
    for (const m of r.matched) {
      const file = list.find((x) => x.f.name === m.file)?.f;
      if (file === undefined) continue;
      const media = await api.upload(file);
      const state = ZoneState.safeParse(m.state);
      if (!state.success) continue;
      editScene((s) => {
        for (const l of s.layers) for (const z of l.zones) if (z.id === m.zone) z.states[state.data] = { ...z.states[state.data], "background-image": `url(${mediaUrl(media.hash)})`, "background-size": "100% 100%" };
      });
    }
    setReport(`${r.matched.length} appliqué(s) · ${r.missing.length} manquant(s)${r.wrongSize.length > 0 ? ` · mauvaise taille : ${r.wrongSize.join(", ")}` : ""}${r.unknown.length > 0 ? ` · inconnus : ${r.unknown.join(", ")}` : ""}`);
  };
  const uploadRef = async (f: File | undefined) => {
    if (f === undefined) return;
    setRefHash((await api.upload(f)).hash);
  };
  const selectFromList = (e: MouseEvent, r: ZoneRef) => {
    setLayerSel(null);
    setSel(e.shiftKey ? toggleRef(sel(), r) : [r]);
  };
  const single = (): { ref: ZoneRef; zone: Zone } | null => {
    const [r, ...rest] = sel();
    const z = r === undefined ? undefined : zoneAt(r);
    return r === undefined || z === undefined || rest.length > 0 ? null : { ref: r, zone: z };
  };
  const editSingle = (f: (z: Zone) => void, key?: string) => {
    const s = single();
    if (s !== null) editScene((sc) => { const z = sc.layers[s.ref.layer]?.zones[s.ref.zone]; if (z !== undefined) f(z); }, key);
  };
  const selectedLayer = (): Layer | undefined => {
    const li = layerSel();
    return li === null ? undefined : scene()?.layers[li];
  };

  return (
      <div class="s-scenes">
        {/* ───── Left: layers and zones ───── */}
        <aside class="s-outline">
          <div class="s-outline-head">
            <span class="s-label">Couches et zones</span>
            <Button kind="ghost" onClick={() => editScene((s) => { s.layers.push({ id: freeId("couche", new Set(s.layers.map((l) => l.id))), name: "Nouvelle couche", z: 40, mode: "auto", phases: [], zones: [] }); })} title="Ajouter une couche">+ couche</Button>
          </div>
          <div class="s-outline-list">
            <For each={scene()?.layers ?? []}>
              {(l, li) => (
                <div class="s-ol-layer" data-hidden={String(hiddenLayers().has(l.id))}>
                  <div class="s-ol-row s-ol-layer-row" data-sel={String(layerSel() === li())} data-off={String(!layerVisible(l, view()?.phase ?? "idle", {}))} title={layerVisible(l, view()?.phase ?? "idle", {}) ? l.name : `${l.name} — absente de l'écran dans la phase simulée`} onClick={() => { setLayerSel(li()); setSel([]); }}>
                    <span class="s-ol-name">{l.name}</span>
                    <span class="q-mono s-ol-z" title="ordre d'empilement (z)">z{l.z}</span>
                    <button type="button" class="s-icon" title={hiddenLayers().has(l.id) ? "Afficher la couche" : "Masquer la couche (dans le studio seulement)"} aria-label="afficher / masquer" onClick={(e) => { e.stopPropagation(); setHiddenLayers(toggleSet(hiddenLayers(), l.id)); }}><EyeIcon off={hiddenLayers().has(l.id)} /></button>
                    <button type="button" class="s-icon" data-on={String(layerLocked(l))} title={layerLocked(l) ? "Déverrouiller la couche" : "Verrouiller la couche (ses zones ne se sélectionnent plus sur le canevas)"} aria-label="verrouiller la couche" onClick={(e) => { e.stopPropagation(); setLocked(toggleSet(locked(), l.id)); }}><LockIcon on={layerLocked(l)} /></button>
                  </div>
                  <For each={l.zones} fallback={<div class="s-ol-empty muted">aucune zone</div>}>
                    {(z, zi) => {
                      const r = (): ZoneRef => ({ layer: li(), zone: zi() });
                      return (
                        <div class="s-ol-row s-ol-zone" data-sel={String(isSel(r()))} onClick={(e) => selectFromList(e, r())}>
                          <span class="s-code q-mono">{ZONE_CODE[z.type] ?? z.type.slice(0, 3).toUpperCase()}</span>
                          <span class="s-ol-name">{z.id}</span>
                          <Show when={overflows(z.rect, size())}><span class="s-ol-tag s-ol-warn" title="Dépasse du cadre 1920×1080">hors cadre</span></Show>
                          <button type="button" class="s-icon" data-on={String(locked().has(`${l.id}/${z.id}`))} title="Verrouiller la zone" aria-label="verrouiller la zone" onClick={(e) => { e.stopPropagation(); setLocked(toggleSet(locked(), `${l.id}/${z.id}`)); }}><LockIcon on={zoneLocked(l, z)} /></button>
                        </div>
                      );
                    }}
                  </For>
                </div>
              )}
            </For>
          </div>
          <details class="s-fold">
            <summary>Gabarit pour le graphiste</summary>
            <div class="s-stack">
              <Button kind="secondary" onClick={() => void exportTemplate("svg")}>Gabarit SVG</Button>
              <Button kind="secondary" onClick={() => void exportTemplate("png")}>Gabarit PNG</Button>
              <Button kind="secondary" onClick={() => void exportTemplate("psd")}>Gabarit PSD (calques)</Button>
              <Button kind="secondary" onClick={() => void exportTemplate("csv")}>Fiche assets (CSV)</Button>
              <Button kind="secondary" onClick={printSheet}>Fiche assets (PDF)</Button>
              <label class="q-btn q-btn-secondary s-file">Réimporter les assets livrés<input type="file" multiple accept="image/png" onChange={(e) => void reimport(e.currentTarget.files)} /></label>
              <p class="muted s-hint">Convention : <code>&lt;zone&gt;_&lt;état&gt;@2x.png</code>, un fichier par état (pas par case).</p>
            </div>
          </details>
          <Show when={report()}>{(r) => <p class="s-report">{r()}</p>}</Show>
          <Show when={psdInfo()}>
            {(i) => (
              <details class="s-fold" open>
                <summary>Relevé du PSD</summary>
                <Show when={i().fonts.length > 0} fallback={<p class="muted">Aucun calque texte.</p>}>
                  <div class="s-stack">
                    <For each={i().fonts}>{(f) => <Button kind="secondary" title={`calque « ${f.layer} » : appliquer au thème`} onClick={() => p.update((d) => { if (d.theme === undefined) d.theme = structuredClone(DEFAULT_THEME); d.theme.font.family = f.name; })}>{f.name}{f.size !== null ? ` · ${Math.round(f.size)} px` : ""}</Button>}</For>
                  </div>
                  <p class="muted s-hint">Vérifier la licence de la police avant diffusion.</p>
                </Show>
                <Show when={i().colors.length > 0}>
                  <p>Couleurs des textes : <For each={i().colors}>{(c) => <button type="button" class="s-chip s-chip-btn" style={{ background: c }} title={c} onClick={() => setPicked(c)} />}</For></p>
                </Show>
              </details>
            )}
          </Show>
        </aside>

        {/* ───── Centre: toolbars + canvas ───── */}
        <section class="s-canvas-col">
          <div class="s-toolbar">
            <select value={sceneIdx()} title="Scène" onChange={(e) => { setSceneIdx(Number(e.currentTarget.value)); setSel([]); setLayerSel(null); }}>
              <For each={scenes()}>{(s, i) => <option value={i()}>{s.name}</option>}</For>
            </select>
            <Show when={p.doc.scenes.length === 0}><span class="muted s-hint" title="Dès la première modification, ces scènes sont copiées dans cette partie (les autres parties ne changent pas).">scènes intégrées</span></Show>
            <select value={phase()} title="Phase simulée" onChange={(e) => { const v = SIMULATED_PHASES.find((x) => x === e.currentTarget.value); if (v !== undefined) setPhase(v); }}>
              <For each={SIMULATED_PHASES}>{(ph) => <option value={ph}>Simuler : {PHASE_LABEL[ph]}</option>}</For>
            </select>
            <label class="s-inline">Question <input class="s-num" type="number" min="1" max={p.doc.questions.length} value={qIndex() + 1} onInput={(e) => setQIndex(Math.max(0, Math.min(p.doc.questions.length - 1, Number(e.currentTarget.value) - 1)))} /></label>
            <span class="s-sep" />
            <div class="s-seg" role="group" aria-label="Zoom">
              <button type="button" data-on={String(zoom() === "fit")} onClick={() => setZoom("fit")}>Ajuster</button>
              <button type="button" data-on={String(zoom() === 0.5)} onClick={() => setZoom(0.5)}>50 %</button>
              <button type="button" data-on={String(zoom() === 1)} onClick={() => setZoom(1)}>100 %</button>
            </div>
            <span class="q-mono muted">{Math.round(scale() * 100)} %</span>
          </div>
          <div class="s-toolbar">
            <div class="s-seg" role="group" aria-label="Outil">
              <button type="button" data-on={String(tool() === "select")} title="Sélection (V)" onClick={() => setTool("select")}>Sélection <kbd>V</kbd></button>
              <button type="button" data-on={String(tool() === "trace")} title="Tracer une zone (T)" onClick={() => setTool("trace")}>Tracer une zone <kbd>T</kbd></button>
              <button type="button" data-on={String(tool() === "pick")} disabled={refHash() === null} title="Couleur sur le calque de référence (I)" onClick={() => setTool("pick")}>Pipette <kbd>I</kbd></button>
            </div>
            <Show when={tool() === "trace"}>
              <select value={traceType()} title="Type de la zone tracée" onChange={(e) => { const t = ZoneType.safeParse(e.currentTarget.value); if (t.success) setTraceType(t.data); }}>
                <For each={ZoneType.options}>{(t) => <option value={t}>{ZONE_LABEL[t]}</option>}</For>
              </select>
            </Show>
            <select class="s-add-zone" value="" title="Ajouter une zone au centre" onChange={(e) => { const t = ZoneType.safeParse(e.currentTarget.value); e.currentTarget.value = ""; if (t.success) addZone(t.data); }}>
              <option value="">+ Ajouter une zone…</option>
              <For each={ZoneType.options}>{(t) => <option value={t}>{ZONE_LABEL[t]}</option>}</For>
            </select>
            <span class="s-sep" />
            <label class="q-btn q-btn-ghost s-file">Calque de référence<input type="file" accept="image/*" onChange={(e) => void uploadRef(e.currentTarget.files?.[0])} /></label>
            <label class="q-btn q-btn-ghost s-file" title="Calques nommés zone:<type>:<id> → zones">Importer un PSD<input type="file" accept=".psd,image/vnd.adobe.photoshop" onChange={(e) => void importPsd(e.currentTarget.files?.[0])} /></label>
            <Show when={refHash()}><label class="s-inline" title="Opacité de la référence">Opacité <input type="range" min="0" max="1" step="0.05" value={refOpacity()} onInput={(e) => setRefOpacity(Number(e.currentTarget.value))} /></label></Show>
            <span class="s-spacer" />
            <button type="button" class="s-help-btn" aria-expanded={help()} title="Raccourcis clavier (?)" onClick={() => setHelp(!help())}>?</button>
          </div>
          <Show when={picked()}>
            {(c) => (
              <div class="s-toolbar s-picked">
                <span class="s-chip" style={{ background: c() }} /> <code class="q-mono">{c()}</code> <span class="muted">appliquer au thème :</span>
                <For each={["primary", "accent", "surface", "text"] as const}>{(k) => <Button kind="secondary" onClick={() => setThemeColor(k, c())}>{COLOR_LABELS[k]}</Button>}</For>
              </div>
            )}
          </Show>
          <Show when={help()}>
            <div class="s-help" role="dialog" aria-label="Raccourcis clavier">
              <div class="s-help-head"><span class="s-label">Raccourcis clavier</span><Button kind="ghost" onClick={() => setHelp(false)}>Fermer</Button></div>
              <dl><For each={SHORTCUTS}>{([k, v]) => <><dt><kbd>{k}</kbd></dt><dd>{v}</dd></>}</For></dl>
              <p class="muted s-hint">Les raccourcis ne s'appliquent pas pendant la saisie dans un champ.</p>
            </div>
          </Show>
          <Show when={previewNote()}>{(n) => <p class="s-hint s-preview-note">{n()}</p>}</Show>
          <div ref={setViewport} class="s-viewport">
            <div class="s-canvas" data-tool={tool()} style={{ "--s": String(scale()), width: `${size().w * scale()}px`, height: `${size().h * scale()}px` }} onPointerDown={onCanvasDown}>
              <div ref={stage} class="s-stage" style={{ width: `${size().w}px`, height: `${size().h}px` }}>
                <Show when={refHash()}>{(h) => <img class="s-ref" src={mediaUrl(h())} alt="" style={{ opacity: refOpacity() }} />}</Show>
                <Show when={shownScene()}>{(sc) => <SceneRenderer scene={sc()} theme={p.doc.theme ?? DEFAULT_THEME} view={view()} serverNow={() => Date.now()} />}</Show>
                <div class="s-safe s-safe-action" style={{ left: `${SAFE_AREAS.action.x}px`, top: `${SAFE_AREAS.action.y}px`, width: `${SAFE_AREAS.action.w}px`, height: `${SAFE_AREAS.action.h}px` }} />
                <div class="s-safe s-safe-graphics" style={{ left: `${SAFE_AREAS.graphics.x}px`, top: `${SAFE_AREAS.graphics.y}px`, width: `${SAFE_AREAS.graphics.w}px`, height: `${SAFE_AREAS.graphics.h}px` }} />
                <For each={scene()?.layers ?? []}>
                  {(l, li) => (
                    <Show when={!hiddenLayers().has(l.id)}>
                      <For each={l.zones}>
                        {(z, zi) => {
                          const r = (): ZoneRef => ({ layer: li(), zone: zi() });
                          const selected = () => isSel(r());
                          const primary = () => sel().length === 1 && selected();
                          return (
                            <div
                              class="s-zone"
                              data-key={refKey(r())}
                              data-sel={String(selected())}
                              data-locked={String(zoneLocked(l, z))}
                              data-warn={String(outsideSafe(z))}
                              data-overflow={String(overflows(z.rect, size()))}
                              data-off={String(!layerVisible(l, view()?.phase ?? "idle", {}) && !selected() && previewed()?.id !== l.id)}
                              style={{ left: `${z.rect.x}px`, top: `${z.rect.y}px`, width: `${z.rect.w}px`, height: `${z.rect.h}px` }}
                              onPointerDown={(e) => startMove(e, r())}
                            >
                              <span class="s-zone-label">{z.id}</span>
                              <Show when={primary()}>
                                <For each={HANDLES}>{(h) => <span class="s-handle" data-h={h} onPointerDown={(e) => startResize(e, r(), h)} />}</For>
                                <span class="s-zone-size q-mono">{z.rect.w}×{z.rect.h}</span>
                              </Show>
                            </div>
                          );
                        }}
                      </For>
                    </Show>
                  )}
                </For>
                <Show when={tracing()}>{(t) => <div class="s-tracing" style={{ left: `${t().x}px`, top: `${t().y}px`, width: `${t().w}px`, height: `${t().h}px` }}><span class="q-mono">{t().w}×{t().h}</span></div>}</Show>
                <Show when={band()}>{(b) => <div class="s-band" style={{ left: `${b().x}px`, top: `${b().y}px`, width: `${b().w}px`, height: `${b().h}px` }} />}</Show>
              </div>
            </div>
          </div>
          <div class="s-statusbar">
            <span class="muted">{sel().length === 0 ? "Cliquez une zone pour la modifier · glisser sur le vide pour en sélectionner plusieurs" : `${sel().length} zone(s) sélectionnée(s) · flèches pour déplacer · Suppr pour supprimer`}</span>
            <span class="s-spacer" />
            <Show when={overflowing().length > 0}>
              <span class="s-warn-text">{overflowing().length} zone(s) hors du cadre</span>
              <Button kind="secondary" onClick={() => fixOverflow(overflowing())}>Tout ramener dans le cadre</Button>
            </Show>
            <span class="muted s-legend"><i class="s-key-action" /> action safe <i class="s-key-graphics" /> graphics safe (EBU R 95)</span>
          </div>
        </section>

        {/* ───── Right: inspector, actions always visible ───── */}
        <aside class="s-inspector">
          <div class="s-inspector-head">
            <Show when={sel().length > 0} fallback={<span class="s-label">{selectedLayer() === undefined ? "Inspecteur" : `Couche « ${selectedLayer()?.name ?? ""} »`}</span>}>
              <span class="s-label">{single() === null ? `${sel().length} zones sélectionnées` : `Zone « ${single()?.zone.id ?? ""} » · ${single()?.zone.type ?? ""}`}</span>
              <div class="s-inspector-actions">
                <Button kind="secondary" onClick={duplicateSelection} title="Ctrl + D">Dupliquer</Button>
                <Button kind="danger" onClick={deleteSelection} title="Suppr">Supprimer</Button>
              </div>
            </Show>
          </div>
          <div class="s-inspector-body">
            <Show when={sel().length > 0} fallback={
              <Show when={selectedLayer()} fallback={
                <div class="s-empty">
                  <p>Cliquez une zone pour la modifier.</p>
                  <p class="muted">Ou choisissez-la dans la liste de gauche (même si sa couche n'est pas à l'écran dans la phase simulée). Glisser sur le vide sélectionne plusieurs zones ; <kbd>?</kbd> affiche les raccourcis.</p>
                </div>
              }>
                {(l) => <LayerInspector layer={l()} edit={(f) => editScene((s) => { const x = s.layers[layerSel() ?? -1]; if (x !== undefined) f(x); })} remove={() => void (async () => { const li = layerSel(); if (li === null) return; if (l().zones.length > 0 && !(await confirmDialog({ title: `Supprimer la couche « ${l().name} » ?`, message: `Et ses ${l().zones.length} zone(s). Annulable (Ctrl+Z).`, confirm: "Supprimer", danger: true }))) return; editScene((s) => { s.layers.splice(li, 1); }); setLayerSel(null); })()} />}
              </Show>
            }>
              <Show when={sel().length > 1}>
                <div class="s-section">
                  <span class="s-label">Aligner sur la première sélectionnée</span>
                  <div class="s-grid3"><For each={ALIGN}>{([m, label]) => <Button kind="secondary" onClick={() => arrange((rs) => alignRects(rs, m, size()))}>{label}</Button>}</For></div>
                  <Show when={sel().length > 2}>
                    <div class="s-grid2">
                      <Button kind="secondary" onClick={() => arrange((rs) => distributeRects(rs, "x"))}>Répartir horizontalement</Button>
                      <Button kind="secondary" onClick={() => arrange((rs) => distributeRects(rs, "y"))}>Répartir verticalement</Button>
                    </div>
                  </Show>
                </div>
              </Show>
              <Show when={single()}>
                {(s) => (
                  <ZoneInspector
                    zone={s().zone}
                    size={size()}
                    doc={p.doc}
                    refHash={refHash()}
                    edit={editSingle}
                    alignToCanvas={(m) => arrange((rs) => alignRects(rs, m, size()))}
                    fixOverflow={() => fixOverflow([s().ref])}
                  />
                )}
              </Show>
            </Show>
          </div>
        </aside>
      </div>
  );
}

function LayerInspector(p: { layer: Layer; edit: (f: (l: Layer) => void) => void; remove: () => void }): JSX.Element {
  return (
    <div class="s-section">
      <label class="s-field"><span class="s-label">Nom</span><input value={p.layer.name} onInput={(e) => { const v = e.currentTarget.value; if (v.length > 0) p.edit((l) => { l.name = v; }); }} /></label>
      <div class="s-grid2">
        <label class="s-field"><span class="s-label">Ordre (z)</span><input class="s-num" type="number" value={p.layer.z} onChange={(e) => p.edit((l) => { l.z = Math.round(Number(e.currentTarget.value) || 0); })} /></label>
        <label class="s-field"><span class="s-label">Affichage</span>
          <select value={p.layer.mode} onChange={(e) => p.edit((l) => { const v = e.currentTarget.value; l.mode = v === "manual" || v === "auto-hold" ? v : "auto"; })}>
            <option value="auto">automatique</option>
            <option value="manual">manuel (TAKE régie)</option>
            <option value="auto-hold">auto, maintenu</option>
          </select>
        </label>
      </div>
      <span class="s-label">Visible pendant (rien coché = toujours)</span>
      <div class="s-phases">
        <For each={PHASES_ALL}>
          {(ph) => <label><input type="checkbox" checked={p.layer.phases.includes(ph)} onChange={(e) => { const on = e.currentTarget.checked; p.edit((l) => { l.phases = on ? [...l.phases, ph] : l.phases.filter((y) => y !== ph); }); }} />{PHASE_SHORT[ph]}</label>}
        </For>
      </div>
      <p class="muted s-hint">Repères z : fond 0, plateau 10, scores 20, classement 30, infos 40, chrono 50, plein écran 90.</p>
      <Button kind="danger" onClick={p.remove}>Supprimer la couche</Button>
    </div>
  );
}

function ZoneInspector(p: { zone: Zone; size: { w: number; h: number }; doc: GameDocument; refHash: string | null; edit: (f: (z: Zone) => void, key?: string) => void; alignToCanvas: (m: (typeof ALIGN)[number][0]) => void; fixOverflow: () => void }): JSX.Element {
  const longest = () => longestText(p.doc, p.zone);
  const nine = () => ({ t: Number(p.zone.props["nineTop"] ?? 0), r: Number(p.zone.props["nineRight"] ?? 0), b: Number(p.zone.props["nineBottom"] ?? 0), l: Number(p.zone.props["nineLeft"] ?? 0) });
  const applyNine = async (f: File | undefined) => {
    if (f === undefined) return;
    const m = await api.upload(f);
    const n = nine();
    p.edit((z) => {
      z.style["border-style"] = "solid";
      z.style["border-width"] = `${n.t}px ${n.r}px ${n.b}px ${n.l}px`;
      z.style["border-image"] = `url(${mediaUrl(m.hash)}) ${n.t} ${n.r} ${n.b} ${n.l} fill / ${n.t}px ${n.r}px ${n.b}px ${n.l}px stretch`;
    });
  };
  return (
    <>
      <div class="s-section">
        <span class="s-label">Position et taille (px)</span>
        <div class="s-grid4">
          <For each={["x", "y", "w", "h"] as const}>
            {(k) => <label class="s-field"><span class="s-label">{k.toUpperCase()}</span><input class="s-num" type="number" value={p.zone.rect[k]} onChange={(e) => { const v = Number(e.currentTarget.value); if (Number.isFinite(v)) p.edit((z) => { z.rect = keepInside({ ...z.rect, [k]: v }, p.size); }); }} /></label>}
          </For>
        </div>
        <Show when={overflows(p.zone.rect, p.size)}>
          <p class="s-warn-text">La zone dépasse du cadre {p.size.w}×{p.size.h}.</p>
          <Button kind="secondary" onClick={p.fixOverflow}>Ramener dans le cadre</Button>
        </Show>
        <Show when={!overflows(p.zone.rect, p.size) && outsideSafe(p.zone)}><p class="s-warn-text">Hors de la zone de sécurité graphique (EBU R 95).</p></Show>
        <div class="s-grid3"><For each={ALIGN}>{([m, label]) => <Button kind="ghost" title={`Aligner sur le canevas : ${label}`} onClick={() => p.alignToCanvas(m)}>{label}</Button>}</For></div>
      </div>
      <div class="s-section">
        <label class="s-field"><span class="s-label">Identifiant</span><input value={p.zone.id} onChange={(e) => { const v = e.currentTarget.value.toLowerCase().replaceAll(/[^0-9a-z-]/g, "-"); if (v.length > 0) p.edit((z) => { z.id = v; }); }} /></label>
        <Show when={p.zone.type === "text"}><TextSource zone={p.zone} edit={p.edit} /></Show>
        <Show when={longest().length > 0}><p class="muted s-hint">Texte le plus long ({longest().length} car.) : « {longest().slice(0, 80)} »</p></Show>
      </div>
      <div class="s-section">
        <div class="s-grid2">
          <Button kind="secondary" onClick={() => p.edit((z) => { z.states = deriveStates(z); })}>Dériver les états</Button>
          <Show when={p.refHash}>{(h) => <Button kind="secondary" title="Le fond de la zone = ce morceau du calque de référence" onClick={() => p.edit((z) => { z.style["background-image"] = `url(${mediaUrl(h())})`; z.style["background-size"] = "1920px 1080px"; z.style["background-position"] = `-${z.rect.x}px -${z.rect.y}px`; })}>Découper le fond</Button>}</Show>
        </div>
      </div>
      <details class="s-fold">
        <summary>Cadre extensible (9-slice)</summary>
        <div class="s-grid4">
          <For each={[["nineTop", "haut"], ["nineRight", "droite"], ["nineBottom", "bas"], ["nineLeft", "gauche"]] as const}>
            {([k, label]) => <label class="s-field"><span class="s-label">{label}</span><input class="s-num" type="number" min="0" value={Number(p.zone.props[k] ?? 0)} onChange={(e) => { const v = Number(e.currentTarget.value) || 0; p.edit((z) => { z.props[k] = v; }); }} /></label>}
          </For>
        </div>
        <label class="q-btn q-btn-secondary s-file">Image du cadre…<input type="file" accept="image/*" onChange={(e) => void applyNine(e.currentTarget.files?.[0])} /></label>
      </details>
      <details class="s-fold">
        <summary>Avancé (JSON)</summary>
        <JsonField label="Options (props)" value={p.zone.props} onChange={(v) => p.edit((z) => { z.props = Object.fromEntries(Object.entries(v).filter((e): e is [string, string | number | boolean] => ["string", "number", "boolean"].includes(typeof e[1]))); })} />
        <JsonField label="Style (CSS)" value={p.zone.style} onChange={(v) => p.edit((z) => { z.style = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)])); })} />
        <JsonField label="États (style par état)" value={p.zone.states} onChange={(v) => p.edit((z) => { z.states = Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === "object" && x !== null).map(([k, x]) => [k, Object.fromEntries(Object.entries(x as object).map(([a, b]) => [a, String(b)]))])); })} /> {/* oxlint-disable-line typescript/no-unsafe-type-assertion -- filtered to objects above */}
      </details>
    </>
  );
}

function zoneCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx !== null) {
    ctx.fillStyle = "rgba(240, 168, 48, 0.25)"; // --ui-accent at 25 % (amber marks the zones to paint)
    ctx.fillRect(0, 0, w, h);
  }
  return c;
}

/**
 * PSD template (doc 07 B): the SVG template as a locked background, then one group per scene layer with one layer per
 * zone named `zone:<type>:<id>` — the designer paints inside, the studio re-imports it as is (« Importer un PSD »).
 */
async function templatePsd(sc: Scene, svg: string): Promise<Blob> {
  const { writePsd } = await import("ag-psd");
  const bg = document.createElement("canvas");
  bg.width = sc.size.w;
  bg.height = sc.size.h;
  const img = new Image();
  img.src = URL.createObjectURL(await svgToPng(svg, sc.size.w, sc.size.h));
  await img.decode();
  bg.getContext("2d")?.drawImage(img, 0, 0);
  URL.revokeObjectURL(img.src);
  const groups = new Map<string, { name: string; left: number; top: number; canvas: HTMLCanvasElement }[]>();
  for (const l of psdTemplateLayers(sc)) groups.set(l.group, [...(groups.get(l.group) ?? []), { name: l.name, left: l.rect.x, top: l.rect.y, canvas: zoneCanvas(l.rect.w, l.rect.h) }]);
  const buf = writePsd({
    width: sc.size.w,
    height: sc.size.h,
    canvas: bg,
    children: [{ name: "Gabarit (référence)", canvas: bg, left: 0, top: 0, protected: { position: true, composite: true, transparency: true } }, ...[...groups].map(([name, children]) => ({ name, opened: true, children }))],
  });
  return new Blob([buf], { type: "image/vnd.adobe.photoshop" });
}
