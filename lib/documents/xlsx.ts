// ShapesOS Phase 11 (seotools): XLSX writer (exceljs — no network).
//
// One workbook, one or more sheets of rows. Numbers, booleans and dates keep
// their type; everything else is written as a STRING cell — a value like
// "=HYPERLINK(…)" from an agent or a dataset is stored as text, never as a
// formula (exceljs only writes formulas for { formula } objects, which this
// writer never produces). Optional header row: bold, frozen, auto-filter.
// Column widths fit the content (capped).

import ExcelJS from "exceljs";

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export type CellValue = string | number | boolean | Date | null | undefined;

export interface SheetInput {
  name: string;
  rows: CellValue[][];
  /** First row is a header (bold, frozen, filter). Default true. */
  header?: boolean;
}

export interface XlsxInput {
  sheets: SheetInput[];
  title?: string | null;
  author?: string | null;
}

export const XLSX_MAX_ROWS = 100_000;
export const XLSX_MAX_COLS = 500;
export const XLSX_MAX_SHEETS = 50;

/** Excel's sheet-name rules: ≤31 chars, none of : \ / ? * [ ], unique. */
export function safeSheetName(raw: string, taken: Set<string>): string {
  let base = (raw || "Sheet").replace(/[:\\/?*[\]]/g, " ").replace(/^'+|'+$/g, "").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n++) {
    const suffix = ` (${n})`;
    base = base.slice(0, 31 - suffix.length);
    name = `${base}${suffix}`;
  }
  taken.add(name.toLowerCase());
  return name;
}

function cellValue(v: CellValue): ExcelJS.CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  // Strings stay strings (never formulas); Excel caps a cell at 32,767 chars.
  return String(v).slice(0, 32_767);
}

/** Build a .xlsx file. Throws on empty input or limits exceeded. */
export async function buildXlsx(input: XlsxInput): Promise<Buffer> {
  if (!input.sheets.length) throw new Error("A spreadsheet needs at least one sheet.");
  if (input.sheets.length > XLSX_MAX_SHEETS) throw new Error(`At most ${XLSX_MAX_SHEETS} sheets.`);
  const wb = new ExcelJS.Workbook();
  wb.creator = input.author?.trim() || "ShapesOS";
  if (input.title) wb.title = input.title;
  wb.created = new Date();
  const taken = new Set<string>();
  for (const sheet of input.sheets) {
    if (sheet.rows.length > XLSX_MAX_ROWS) throw new Error(`Sheet "${sheet.name}" has ${sheet.rows.length} rows (max ${XLSX_MAX_ROWS}).`);
    const ws = wb.addWorksheet(safeSheetName(sheet.name, taken));
    const widths: number[] = [];
    for (const row of sheet.rows) {
      if (row.length > XLSX_MAX_COLS) throw new Error(`Sheet "${sheet.name}" has a row with ${row.length} columns (max ${XLSX_MAX_COLS}).`);
      const values = row.map(cellValue);
      ws.addRow(values);
      values.forEach((v, i) => {
        const len = v === null ? 0 : v instanceof Date ? 10 : String(v).length;
        widths[i] = Math.max(widths[i] ?? 8, Math.min(60, len + 2));
      });
    }
    widths.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });
    if (sheet.header !== false && sheet.rows.length > 0) {
      ws.getRow(1).font = { bold: true };
      ws.views = [{ state: "frozen", ySplit: 1 }];
      const cols = Math.max(1, sheet.rows[0].length);
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rows.length), column: cols } };
    }
    for (const [i, row] of sheet.rows.entries()) {
      row.forEach((v, c) => {
        if (v instanceof Date) ws.getCell(i + 1, c + 1).numFmt = "yyyy-mm-dd";
      });
    }
  }
  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** Read the first rows of every sheet of an .xlsx (for previews and tests). */
export async function readXlsx(bytes: Buffer, maxRows = 1000): Promise<{ name: string; rows: CellValue[][] }[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  return wb.worksheets.map((ws) => {
    const rows: CellValue[][] = [];
    ws.eachRow({ includeEmpty: true }, (row, n) => {
      if (n > maxRows) return;
      const vals = (row.values as ExcelJS.CellValue[]).slice(1).map((v) => {
        if (v && typeof v === "object" && !(v instanceof Date)) {
          const o = v as { result?: unknown; text?: unknown; richText?: { text: string }[] };
          if (o.richText) return o.richText.map((r) => r.text).join("");
          return (o.result ?? o.text ?? null) as CellValue;
        }
        return v as CellValue;
      });
      rows.push(vals);
    });
    return { name: ws.name, rows };
  });
}
