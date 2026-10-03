// ShapesOS — one CSV cell encoder for every export (Phase 1).
//
// RFC 4180 quoting PLUS spreadsheet formula-injection neutralization
// (OWASP "CSV injection"): a text cell that starts with = + - @ TAB or CR
// is prefixed with a single quote so Excel/Sheets/LibreOffice treat it as
// text, not a formula (=HYPERLINK(...), =cmd|'/c calc'!A1, @SUM(...)).
// Exported data includes attacker-controlled text (public lead forms,
// imported datasets, collaborator-edited sheets), so every CSV export uses
// this helper.
//
// Numbers are emitted as-is (a negative number is data, not a formula).

const FORMULA_TRIGGER = /^[=+\-@\t\r]/;

export interface CsvCellOptions {
  /** Quote every cell (some exports always quote). Default: only when needed. */
  alwaysQuote?: boolean;
}

export function csvCell(value: unknown, opts: CsvCellOptions = {}): string {
  if (value === null || value === undefined) return opts.alwaysQuote ? '""' : "";
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return opts.alwaysQuote ? '""' : "";
    s = String(value);
  } else if (typeof value === "bigint") {
    s = String(value);
  } else {
    s = value instanceof Date ? value.toISOString() : String(value);
    if (FORMULA_TRIGGER.test(s)) s = `'${s}`;
  }
  if (opts.alwaysQuote || /[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/** Encode one CSV row (no trailing newline). */
export function csvRow(values: readonly unknown[], opts: CsvCellOptions = {}): string {
  return values.map((v) => csvCell(v, opts)).join(",");
}
