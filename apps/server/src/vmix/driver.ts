import { z } from "zod";
import type { MechanicView, OutputView } from "@quiz/schema";
import type { SessionRuntime } from "../runtime/session-runtime.ts";

/**
 * vMix titles (doc 08 phase 5): keeps fields of a vMix title input in sync with the show, through the vMix HTTP
 * API (verified on vmix.com/help29/DeveloperAPI.html): `GET <url>/api/?Function=SetText&Input=<input>&
 * SelectedName=<field>&Value=<text>` — GT titles name their fields `<Name>.Text`. 200 = OK, 500 = error.
 * Only changed fields are sent, one request at a time (the TCP API asks to wait for each answer; we do the same
 * over HTTP). Overlays: `OverlayInput<n>In` / `OverlayInput<n>Out` on phase changes when configured.
 */

/** What a title field can show. `option.<i>` is the i-th answer (1-based), `rank.<i>.name|total` the leaderboard. */
export const Binding = z.union([
  z.enum(["question.text", "question.number", "round.title", "phase", "answer", "leader.name", "leader.total"]),
  z.string().regex(/^option\.[1-8](\.(label|percent))?$/),
  z.string().regex(/^rank\.([1-9]|10)\.(name|total)$/),
]);

export const VmixConfig = z.strictObject({
  /** vMix Web Controller address, e.g. http://192.168.1.40:8088 */
  url: z.url().regex(/^https?:\/\//),
  /** Title input: number, name (case-sensitive) or GUID. */
  input: z.string().min(1).max(200),
  /** vMix field name (e.g. "Question.Text") → binding. */
  fields: z.record(z.string().min(1).max(100), Binding),
  /** Optional overlay channel put IN while a question is on air, OUT otherwise. */
  overlay: z.number().int().min(1).max(8).optional(),
});
export type VmixConfig = z.infer<typeof VmixConfig>;

const ON_AIR = new Set(["presenting", "open", "locked", "judging", "revealed"]);

function optionsOf(m: MechanicView | null): readonly { id: string; label: string }[] {
  if (m === null) return [];
  if ("options" in m && Array.isArray(m.options)) return m.options;
  return [];
}

function percentOf(m: MechanicView | null, id: string): string {
  if (m === null || !("counts" in m) || m.counts === null) return "";
  const total = Object.values(m.counts).reduce((a, b) => a + b, 0);
  return total === 0 ? "0 %" : `${Math.round(((m.counts[id] ?? 0) / total) * 100)} %`;
}

/** The right answer once it is public on air (choice-like mechanics and typed answers). */
function answerOf(v: OutputView): string {
  const m = v.mechanic;
  if (m === null || v.phase !== "revealed" || !("correct" in m) || m.correct === null) return "";
  const c = m.correct;
  const label = (id: string) => optionsOf(m).find((o) => o.id === id)?.label ?? id;
  if (Array.isArray(c)) return c.map((x) => (typeof x === "string" ? label(x) : "")).join(" + ");
  if (typeof c === "number") return String(c);
  if (typeof c === "string") return optionsOf(m).some((o) => o.id === c) ? label(c) : c;
  return "";
}

/** Pure: the value of every configured field for this view. */
export function fieldValues(v: OutputView, fields: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const opts = optionsOf(v.mechanic);
  for (const [field, binding] of Object.entries(fields)) {
    let value = "";
    if (binding === "question.text") value = v.question?.prompt.text ?? "";
    else if (binding === "question.number") value = v.question === null ? "" : `${v.question.index + 1} / ${v.question.count}`;
    else if (binding === "round.title") value = v.round?.title ?? "";
    else if (binding === "phase") value = v.phase;
    else if (binding === "answer") value = answerOf(v);
    else if (binding === "leader.name") value = v.leaderboard[0]?.displayName ?? "";
    else if (binding === "leader.total") value = v.leaderboard[0] === undefined ? "" : String(v.leaderboard[0].total);
    else {
      const opt = /^option\.(\d)(?:\.(label|percent))?$/.exec(binding);
      const rank = /^rank\.(\d+)\.(name|total)$/.exec(binding);
      if (opt !== null) {
        const o = opts[Number(opt[1]) - 1];
        value = o === undefined ? "" : opt[2] === "percent" ? percentOf(v.mechanic, o.id) : o.label;
      } else if (rank !== null) {
        const r = v.leaderboard[Number(rank[1]) - 1];
        value = r === undefined ? "" : rank[2] === "name" ? r.displayName : String(r.total);
      }
    }
    // Nothing on air: blank the question fields (a stale question must never stay in a vMix title).
    out[field] = ON_AIR.has(v.phase) || binding.startsWith("rank.") || binding.startsWith("leader.") || binding === "round.title" || binding === "phase" ? value : "";
  }
  return out;
}

type Fetch = typeof fetch;
export type VmixStatus = { enabled: boolean; ok: boolean; sent: number; errors: number; lastError: string | null };

export class VmixDriver {
  readonly status: VmixStatus = { enabled: false, ok: true, sent: 0, errors: 0, lastError: null };
  private config: VmixConfig | null = null;
  private last = new Map<string, string>();
  private overlayOn: boolean | null = null;
  /** Latest value per pending call key (field or overlay): a stale value is never sent (review 4 I5). */
  private readonly pending = new Map<string, Record<string, string>>();
  private draining: Promise<void> | null = null;
  private lastView: OutputView | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly fetchFn: Fetch;

  constructor(fetchFn: Fetch = fetch) {
    this.fetchFn = fetchFn;
  }

  get current(): VmixConfig | null {
    return this.config;
  }

  /** Starts following the session (re-call after a session switch). */
  attach(rt: SessionRuntime, config: VmixConfig | null): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.config = config;
    this.last = new Map();
    this.overlayOn = null;
    this.status.enabled = config !== null;
    if (config === null) return;
    const viewer = { role: "output", scene: "program" } as const;
    this.unsubscribe = rt.subscribe({ viewer, update: (frame) => frame.view.role === "output" && this.push(frame.view) });
    const v = rt.view(viewer);
    if (v.role === "output") this.push(v);
  }

  private call(params: Record<string, string>): Promise<void> {
    const cfg = this.config;
    if (cfg === null) return Promise.resolve();
    const url = `${cfg.url.replace(/\/+$/, "")}/api/?${new URLSearchParams(params).toString()}`;
    return this.fetchFn(url, { signal: AbortSignal.timeout(3000) }).then(
      (res) => {
        if (res.ok) {
          this.status.sent++;
          this.status.ok = true;
        } else {
          this.failed(params, `vMix a répondu ${res.status} (${params["Function"] ?? ""} ${params["SelectedName"] ?? ""})`);
        }
      },
      (err: unknown) => this.failed(params, `vMix injoignable : ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /** Not delivered: forget it (so it counts as changed) and retry with the LATEST view in 2 s. */
  private failed(params: Record<string, string>, message: string): void {
    this.status.errors++;
    this.status.ok = false;
    this.status.lastError = message;
    const field = params["SelectedName"];
    if (field !== undefined) this.last.delete(field);
    else this.overlayOn = null;
    if (this.retryTimer === null) {
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null;
        if (this.lastView !== null) this.push(this.lastView);
      }, 2000);
      this.retryTimer.unref();
    }
  }

  /** Queues the changed fields (strictly one request after the other, never blocking the game loop). */
  private push(v: OutputView): boolean {
    const cfg = this.config;
    if (cfg === null) return false;
    this.lastView = v;
    const values = fieldValues(v, cfg.fields);
    for (const [field, value] of Object.entries(values)) {
      if (this.last.get(field) === value) continue;
      this.last.set(field, value);
      this.pending.set(`field:${field}`, { Function: "SetText", Input: cfg.input, SelectedName: field, Value: value });
    }
    if (cfg.overlay !== undefined) {
      const on = ON_AIR.has(v.phase);
      if (on !== this.overlayOn) {
        this.overlayOn = on;
        const fn = on ? `OverlayInput${cfg.overlay}In` : `OverlayInput${cfg.overlay}Out`;
        this.pending.set("overlay", on ? { Function: fn, Input: cfg.input } : { Function: fn });
      }
    }
    this.draining ??= this.drain().finally(() => {
      this.draining = null;
    });
    return true;
  }

  /** One request at a time; each takes the latest pending value of its key (bounded by the number of fields). */
  private async drain(): Promise<void> {
    for (let next = this.pending.entries().next(); !next.done; next = this.pending.entries().next()) {
      const [key, params] = next.value;
      this.pending.delete(key);
      await this.call(params);
    }
  }

  /** Resolves when everything pending has been sent (tests). */
  async flush(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  close(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
