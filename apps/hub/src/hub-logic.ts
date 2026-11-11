/** Pure helpers of the home page (tested). */

export type HubEntry = { readonly label: string; readonly id: string; readonly role: string; readonly path: string };
export type HubData = {
  readonly title: string;
  readonly players: number;
  readonly maxPlayers: number;
  readonly joinCode: string;
  readonly origins: readonly string[];
  readonly local: boolean;
  readonly staffCode: string | null;
  readonly entries: readonly HubEntry[];
};

export type Station = { readonly entry: HubEntry; readonly name: string; readonly hint: string };

const STATIONS: Record<string, { name: string; hint: string; order: number }> = {
  control: { name: "Régie", hint: "Piloter le show : déroulé, antenne, scores, corrections", order: 0 },
  host: { name: "Animateur", hint: "Question, réponse attendue, fiche, qui a la main", order: 1 },
  studio: { name: "Studio", hint: "Créer les jeux : questions, manches, scènes, thème", order: 2 },
  "control-readonly": { name: "Régie — lecture seule", hint: "Suivre le show sans pouvoir agir (réalisation, producteur)", order: 3 },
};

/** Workstations (control, host, studio…) in a fixed order. */
export function stations(entries: readonly HubEntry[]): Station[] {
  return entries
    .flatMap((entry) => {
      const s = STATIONS[entry.id];
      return s === undefined ? [] : [{ entry, name: s.name, hint: s.hint, order: s.order }];
    })
    .toSorted((a, b) => a.order - b.order)
    .map(({ entry, name, hint }) => ({ entry, name, hint }));
}

export const outputs = (entries: readonly HubEntry[]): HubEntry[] => entries.filter((e) => e.role === "output");
export const seats = (entries: readonly HubEntry[]): HubEntry[] => entries.filter((e) => e.role === "seat");

/**
 * Origin to put in the links for OTHER machines (OBS on another PC, tablets): the page's own origin, unless the
 * page was opened as localhost on the server PC — then the first LAN address.
 */
export function shareOrigin(pageOrigin: string, origins: readonly string[]): string {
  const host = new URL(pageOrigin).hostname;
  const local = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  return local ? (origins[0] ?? pageOrigin) : pageOrigin;
}

/** Join code "123456" → "123 456"; team code "ABCD2345" → "ABCD 2345" (read out loud). */
export const spacedCode = (code: string): string => (/^\d+$/.test(code) ? code.replaceAll(/(\d{3})(?=\d)/g, "$1 ") : code.replaceAll(/(.{4})(?=.)/g, "$1 "));

/** Scene name of an output link (`out-program` → `program`). */
export const sceneOf = (e: HubEntry): string => e.id.replace(/^out-/, "");
