import { createEffect, createSignal, type JSX } from "solid-js";

/** JSON object editor (advanced fallback): applied on blur, red border while the text is not a JSON object. */
export function JsonField(p: { label: string; value: unknown; onChange: (v: Record<string, unknown>) => void; rows?: number }): JSX.Element {
  const [text, setText] = createSignal(JSON.stringify(p.value, null, 1));
  const [bad, setBad] = createSignal(false);
  createEffect(() => setText(JSON.stringify(p.value, null, 1)));
  return (
    <label class="s-json">
      <span class="s-label">{p.label}</span>
      <textarea rows={p.rows ?? 3} data-bad={String(bad())} value={text()} onInput={(e) => setText(e.currentTarget.value)} onBlur={() => {
        try {
          const v: unknown = JSON.parse(text());
          if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("objet attendu");
          setBad(false);
          p.onChange(Object.fromEntries(Object.entries(v)));
        } catch {
          setBad(true);
        }
      }} />
    </label>
  );
}

/** Number input applied on change; empty → `onEmpty` when given (optional fields), else ignored. */
export function NumField(p: { value: number | undefined; onChange: (v: number) => void; onEmpty?: () => void; min?: number | undefined; max?: number | undefined; step?: number | undefined; title?: string | undefined; class?: string; placeholder?: string | undefined; label?: string | undefined }): JSX.Element {
  return (
    <input
      aria-label={p.label ?? p.title ?? "Valeur"}
      class={`s-num ${p.class ?? ""}`}
      type="number"
      min={p.min}
      max={p.max}
      step={p.step ?? 1}
      title={p.title}
      placeholder={p.placeholder}
      value={p.value ?? ""}
      onChange={(e) => {
        const raw = e.currentTarget.value.trim();
        if (raw === "") {
          p.onEmpty?.();
          return;
        }
        const n = Number(raw);
        if (Number.isFinite(n)) p.onChange(n);
      }}
    />
  );
}
