import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import { DEFAULT_THEME, GameDocument, Material, OUTPUT_SCENES, SoundCue, type Scene, type Theme } from "@quiz/schema";
import { SceneRenderer, dominantColors, generateThemes } from "@quiz/renderer";
import { Button, Panel } from "@quiz/ui";
import { api, mediaUrl } from "./api.ts";
import { COLOR_LABELS } from "./scene-editor.tsx";
import { simulateView } from "./studio-logic.ts";
import { snapshot, type Update } from "./util.ts";

// ───────────────────────────── Thème ─────────────────────────────

const MATERIAL_LABEL: Record<Material, string> = { flat: "aplat", gradient: "dégradé", glass: "verre", metal: "métal", neon: "néon", paper: "papier", led: "LED" };
const CUE_LABEL: Record<SoundCue, string> = { "answer.correct": "Bonne réponse", "answer.wrong": "Mauvaise réponse", "timer.last5": "5 dernières secondes", "buzzer.won": "Buzzer : la main", "ladder.reached": "Palier franchi", "leader.changed": "Nouveau leader", podium: "Podium" };


export function ThemeEditor(p: { doc: GameDocument; update: Update }): JSX.Element {
  const theme = (): Theme => p.doc.theme ?? DEFAULT_THEME;
  const [c1, setC1] = createSignal(theme().colors.primary);
  const [c2, setC2] = createSignal(theme().colors.accent);
  const variants = createMemo(() => generateThemes(c1(), c2(), theme().font.family));
  const set = (f: (t: Theme) => void) => p.update((d) => { if (d.theme === undefined) d.theme = structuredClone(DEFAULT_THEME); f(d.theme); });
  const [logoMsg, setLogoMsg] = createSignal<string | null>(null);
  const uploadLogo = async (f: File | undefined) => {
    if (f === undefined) return;
    const m = await api.upload(f);
    set((t) => { t.logo = m.hash; });
    // Palette from the logo: its two dominant hues feed the generator below.
    const img = new Image();
    img.src = mediaUrl(m.hash);
    await img.decode();
    const c = document.createElement("canvas");
    const k = Math.min(1, 256 / Math.max(img.naturalWidth || 256, img.naturalHeight || 256));
    c.width = Math.max(1, Math.round((img.naturalWidth || 256) * k));
    c.height = Math.max(1, Math.round((img.naturalHeight || 256) * k));
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx?.drawImage(img, 0, 0, c.width, c.height);
    const colors = ctx === null ? [] : dominantColors(ctx.getImageData(0, 0, c.width, c.height).data);
    const [a, b] = colors;
    if (a !== undefined) setC1(a);
    if (b !== undefined) setC2(b);
    setLogoMsg(colors.length === 0 ? "Logo sans couleur dominante (gris / noir et blanc) : couleurs inchangées." : `Couleurs du logo : ${colors.join(", ")}`);
  };
  const uploadSound = async (cue: SoundCue, f: File | undefined) => {
    if (f === undefined) return;
    const m = await api.upload(f);
    set((t) => { t.sounds[cue] = m.hash; });
  };
  const view = createMemo(() => {
    const v = GameDocument.safeParse(snapshot(p.doc));
    return v.success ? simulateView(v.data, "revealed") : null;
  });
  return (
    <div class="s-theme">
      <Panel title="Générer depuis 2 couleurs (ou depuis le logo)">
        <div class="s-row">
          <label class="q-btn q-btn-secondary s-file">Logo…<input type="file" accept="image/png,image/svg+xml,image/webp,image/jpeg" onChange={(e) => void uploadLogo(e.currentTarget.files?.[0])} /></label>
          <Show when={theme().logo}>{(h) => <img class="s-logo" src={mediaUrl(h())} alt="logo" />}</Show>
          <Show when={logoMsg()}>{(m) => <span class="muted">{m()}</span>}</Show>
        </div>
        <div class="s-row">
          <label>Couleur 1 <input type="color" value={c1()} onInput={(e) => setC1(e.currentTarget.value)} /></label>
          <label>Couleur 2 <input type="color" value={c2()} onInput={(e) => setC2(e.currentTarget.value)} /></label>
        </div>
        <div class="s-variants">
          <For each={variants()}>
            {(v) => (
              <div class="s-variant">
                <div class="s-swatches"><For each={Object.values(v.theme.colors)}>{(c) => <span style={{ background: c }} />}</For></div>
                <b>{v.theme.name}</b>
                <ul><For each={v.report}>{(r) => <li data-ok={String(r.ok)}>{r.ok ? "✓" : "✗"} {r.label} {r.ratio}:1</li>}</For></ul>
                <Button onClick={() => p.update((d) => { const keep = theme(); d.theme = { ...structuredClone(v.theme), material: keep.material, sounds: { ...keep.sounds }, volume: keep.volume, ...(keep.logo !== undefined ? { logo: keep.logo } : {}) }; })}>Appliquer</Button>
              </div>
            )}
          </For>
        </div>
      </Panel>
      <Panel title="Réglages fins">
        <div class="s-colors">
          <For each={Object.keys(COLOR_LABELS) as (keyof Theme["colors"])[]}>{/* oxlint-disable-line typescript/no-unsafe-type-assertion -- keys of a literal record */}
            {(k) => <label><input type="color" value={theme().colors[k].slice(0, 7)} onInput={(e) => set((t) => { t.colors[k] = e.currentTarget.value; })} /> {COLOR_LABELS[k]}</label>}
          </For>
        </div>
        <label>Police <input value={theme().font.family} onChange={(e) => set((t) => { t.font.family = e.currentTarget.value; })} /></label>
        <label>Arrondis <input type="range" min="0" max="40" value={theme().radius} onInput={(e) => set((t) => { t.radius = Number(e.currentTarget.value); })} /> {theme().radius}px</label>
        <label>Matériau des cadres <select value={theme().material} onChange={(e) => { const m = Material.safeParse(e.currentTarget.value); if (m.success) set((t) => { t.material = m.data; }); }}>
          <For each={Material.options}>{(m) => <option value={m}>{MATERIAL_LABEL[m]}</option>}</For>
        </select></label>
        <label>Mouvement <select value={theme().motion} onChange={(e) => set((t) => { const m = e.currentTarget.value; t.motion = m === "elegant" || m === "bouncy" || m === "dramatic" ? m : "snappy"; })}>
          <option value="snappy">vif</option><option value="elegant">élégant</option><option value="bouncy">rebond</option><option value="dramatic">dramatique</option>
        </select></label>
      </Panel>
      <Panel title="Pack sonore (moments)">
        <p class="muted">Joué par les sorties ouvertes avec <code>&amp;sound=on</code> (capté par OBS / vMix). Importé en WAV 48 kHz.</p>
        <div class="s-sounds">
          <For each={SoundCue.options}>
            {(cue) => (
              <div class="s-row">
                <span class="s-cue">{CUE_LABEL[cue]}</span>
                <Show when={theme().sounds[cue]} fallback={<span class="muted">—</span>}>
                  {(h) => (
                    <>
                      <Button kind="ghost" onClick={() => { const a = new Audio(mediaUrl(h())); a.volume = theme().volume; void a.play(); }}>▶</Button>
                      <Button kind="ghost" onClick={() => set((t) => { delete t.sounds[cue]; })}>Retirer</Button>
                    </>
                  )}
                </Show>
                <label class="q-btn q-btn-ghost s-file">Son…<input type="file" accept="audio/*" onChange={(e) => void uploadSound(cue, e.currentTarget.files?.[0])} /></label>
              </div>
            )}
          </For>
        </div>
        <label>Volume <input type="range" min="0" max="1" step="0.05" value={theme().volume} onInput={(e) => set((t) => { t.volume = Number(e.currentTarget.value); })} /> {Math.round(theme().volume * 100)} %</label>
      </Panel>
      <Panel title="Aperçu (programme, réponse révélée)">
        <div class="s-mini"><SceneRenderer scene={p.doc.scenes.find((s) => s.id === "program") ?? OUTPUT_SCENES["program"] ?? (p.doc.scenes[0] as Scene)} theme={theme()} view={view()} serverNow={() => Date.now()} fit /></div> {/* oxlint-disable-line typescript/no-unsafe-type-assertion -- presets always contain program */}
      </Panel>
    </div>
  );
}

