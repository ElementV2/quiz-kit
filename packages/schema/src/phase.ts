import { z } from "zod";

/** Game phases (doc 03 « Cycle par défaut d'une question »). Own file: imported by views, scenes and session. */
export const Phase = z.enum(["lobby", "idle", "presenting", "open", "locked", "judging", "revealed", "round.end", "game.end"]);
export type Phase = z.infer<typeof Phase>;
