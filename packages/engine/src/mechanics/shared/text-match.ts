/**
 * Fuzzy text matching for typed answers (text-answer, hints, reveal-image). Pure and deterministic.
 * "Élysée", "elysee" and "l'Elysée !" are the same answer; small typos are tolerated by length.
 */

const LEADING_ARTICLES = /^(?:(?:le|la|les|l|un|une|des|du|de|d|the|a|an)\s+)+/;

/** Lower case, no accents, no punctuation, single spaces, no leading article. */
export function normalizeAnswer(text: string): string {
  const base = text
    .normalize("NFD")
    .replaceAll(/\p{M}/gu, "") // combining accents left by NFD
    .toLowerCase()
    .replaceAll("œ", "oe")
    .replaceAll("æ", "ae")
    .replaceAll("ß", "ss")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  const stripped = base.replace(LEADING_ARTICLES, "");
  // "Les" alone stays "les": never reduce an answer to nothing.
  return stripped.length > 0 ? stripped : base;
}

/** Levenshtein distance, stops early above `max` (returns max + 1). */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

/** Default tolerance by length of the expected answer: 0 up to 4 letters, 1 up to 8, else 2. */
export function defaultDistance(expected: string): number {
  const n = expected.replaceAll(" ", "").length;
  return n <= 4 ? 0 : n <= 8 ? 1 : 2;
}

export type TextSpec = { readonly accepted: readonly string[]; readonly maxDistance?: number | undefined };

/** True when `given` matches one of the accepted answers. Numbers must match exactly ("1789" ≠ "1788"). */
export function matchesText(given: string, spec: TextSpec): boolean {
  const g = normalizeAnswer(given);
  if (g.length === 0) return false;
  return spec.accepted.some((raw) => {
    const e = normalizeAnswer(raw);
    if (g === e) return true;
    if (/\p{N}/u.test(e)) return false;
    const max = spec.maxDistance ?? defaultDistance(e);
    return max > 0 && editDistance(g, e, max) <= max;
  });
}
