// ShapesOS — Spotlight source helpers (pure).

/** Integer cents → "$1,234.50" (ledger currency; the palette shows it as-is). */
export function money(cents: number | null): string {
  if (cents === null || !Number.isFinite(cents)) return "";
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** First `n` characters of a whitespace-collapsed text. */
export function excerpt(text: string | null | undefined, n = 120): string | null {
  if (!text) return null;
  const t = text.replace(/\s+/g, " ").trim();
  return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null;
}
