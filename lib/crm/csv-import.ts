// ShapesOS — CRM CSV import: pure parsing helpers (no DB).
// Used by POST /api/crm/leads/import. Kept pure so row numbering and value
// bounds are unit-testable.

/** Lead.valueCents is a Postgres int4. */
export const MAX_LEAD_VALUE_CENTS = 2_147_483_647;

export interface ParsedCsv {
  rows: string[][];
  /**
   * 1-based source line each row starts on, parallel to `rows`. Blank lines
   * are dropped from `rows` but still counted here, so an error on a data row
   * names the line the user sees in their editor/spreadsheet.
   */
  lines: number[];
}

/** Minimal RFC-4180-ish CSV parse (quotes, commas, newlines in quotes), with source line numbers. */
export function parseCsvWithLines(input: string): ParsedCsv {
  // A UTF-8 BOM (Excel's default export) would otherwise rename the first header.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  const lines: number[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let line = 1;
  let rowStart = 1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\n") line++;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); lines.push(rowStart); row = []; field = ""; rowStart = line; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") { rows.push(row); lines.push(rowStart); }
  const keep = rows.map((r) => r.some((f) => f.trim() !== ""));
  return { rows: rows.filter((_, i) => keep[i]), lines: lines.filter((_, i) => keep[i]) };
}

/**
 * Parse the "value" column (dollars, "$" and "," allowed) to integer cents.
 * Empty → null. Out-of-range or non-numeric → a clear error message.
 */
export function parseLeadValueCents(raw: string): { cents: number | null } | { error: string } {
  const cleaned = raw.trim().replace(/[$,]/g, "");
  if (!cleaned) return { cents: null };
  const dollars = Number(cleaned);
  if (!Number.isFinite(dollars)) return { error: `invalid value "${raw.trim()}": must be a number of dollars` };
  const cents = Math.round(dollars * 100);
  if (cents < 0) return { error: `invalid value "${raw.trim()}": must not be negative` };
  if (cents > MAX_LEAD_VALUE_CENTS) {
    return { error: `invalid value "${raw.trim()}": must be at most $21,474,836.47` };
  }
  return { cents };
}
