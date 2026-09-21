// Marketr — competitor domain helpers (spec §5 flow 2).

/** Normalize a user-typed domain. Returns null when it doesn't look like a domain. */
export function normalizeDomain(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.trim().toLowerCase();
  if (!d) return null;
  d = d
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .split("?")[0]
    .split("#")[0]
    .split(":")[0]
    .trim();
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d)) return null;
  return d;
}

/** Normalize a keyword phrase for gap diffing (case/whitespace-insensitive). */
export function normalizePhrase(phrase: string): string {
  return phrase.trim().toLowerCase();
}

/**
 * Opportunity score: volume weighted by (1 − difficulty). Null volume counts
 * as 0, null difficulty counts as 50 (mid). Used to sort gap results so
 * high-volume / low-difficulty keywords come first.
 */
export function opportunityScore(
  volume: number | null,
  difficulty: number | null,
): number {
  const v = volume ?? 0;
  const d =
    difficulty == null ? 50 : Math.min(100, Math.max(0, difficulty));
  return v * ((100 - d) / 100);
}
