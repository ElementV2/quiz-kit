import { z } from "zod";
import { ParticipantId } from "./ids.ts";

export const Role = z.enum(["control", "control-readonly", "scorer", "host", "output", "player", "seat", "studio", "system"]);
export type Role = z.infer<typeof Role>;

export const SceneName = z.string().min(1).max(64).regex(/^[0-9a-z-]+$/);

/** Who receives a projected view (doc 01, "Rôles"). */
export const Viewer = z.discriminatedUnion("role", [
  z.strictObject({ role: z.literal("control") }),
  z.strictObject({ role: z.literal("control-readonly") }),
  z.strictObject({ role: z.literal("scorer") }),
  z.strictObject({ role: z.literal("host") }),
  z.strictObject({ role: z.literal("output"), scene: SceneName }),
  z.strictObject({ role: z.literal("player"), participantId: ParticipantId }),
  z.strictObject({ role: z.literal("seat"), seat: z.number().int().min(1).max(999) }),
  z.strictObject({ role: z.literal("studio") }),
]);
export type Viewer = z.infer<typeof Viewer>;

/** Author of an event, stamped by the server — never trusted from the client. */
export const Actor = z.strictObject({
  role: Role,
  /** participantId for player / seat, operator name or client id otherwise. */
  id: z.string().min(1).max(64).optional(),
});
export type Actor = z.infer<typeof Actor>;
