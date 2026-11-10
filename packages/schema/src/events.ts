import { z } from "zod";
import { Action } from "./actions.ts";
import { Actor } from "./roles.ts";

/** Journal entry (append-only, ADR-0003 / ADR-0010). */
export const Event = z.strictObject({
  seq: z.number().int().min(1),
  /** Server wall-clock time, ms. */
  at: z.number().int().nonnegative(),
  actor: Actor,
  action: Action,
  idempotencyKey: z.string().min(8).max(64).nullable(),
});
export type Event = z.infer<typeof Event>;
