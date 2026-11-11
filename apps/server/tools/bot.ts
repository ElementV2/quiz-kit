import type { QuizClient } from "@quiz/protocol";
import type { View } from "@quiz/schema";

export type AckedAnswer = { readonly key: string; readonly questionId: string; readonly participantId: string };

/**
 * Simulated player (doc 07 "Mode Répétition", chaos / load). Answers once per question when the view says it can,
 * after a random think time. Records what the server acknowledged — the ground truth for "0 lost answer".
 */
export class Bot {
  readonly acked: AckedAnswer[] = [];
  readonly rejected: { questionId: string; reason: string }[] = [];
  private answered = new Set<string>();
  private readonly client: QuizClient;
  private readonly random: () => number;
  private readonly thinkMs: number;

  constructor(client: QuizClient, opts: { random?: () => number; thinkMs?: number } = {}) {
    this.client = client;
    this.random = opts.random ?? Math.random;
    this.thinkMs = opts.thinkMs ?? 1500;
    const tick = setInterval(() => this.maybeAnswer(), 50);
    tick.unref();
  }

  get queueLength(): number {
    return this.client.queued.length;
  }

  get view(): View | null {
    return this.client.view;
  }

  private maybeAnswer(): void {
    const v = this.client.view;
    if (v === null || v.role !== "player" || !v.canAnswer || v.me === null || v.question === null || v.mechanic?.mechanic !== "choice") return;
    const qid = v.question.id;
    if (this.answered.has(qid) || v.myAnswer !== null) return;
    this.answered.add(qid);
    const options = v.mechanic.options;
    const pick = options[Math.floor(this.random() * options.length)]?.id ?? "a";
    const pid = v.me.participantId;
    setTimeout(() => {
      // The key is generated inside submit(); we learn it through the ack callback order (one pending per question).
      void this.client.submit({ type: "answer.submit", participantId: pid, answer: { kind: "choice", optionIds: [pick] } }).then((ack) => {
        if (ack.ok) this.acked.push({ key: ack.key, questionId: qid, participantId: pid });
        else this.rejected.push({ questionId: qid, reason: ack.reason });
      });
    }, this.random() * this.thinkMs);
  }
}
