// Marketr — Phase 11 "Canvas" FEATURE 5: template variables + batch generation.
//
// Text elements can contain {{variable}} placeholders (e.g. "50% off
// {{product}} — ends {{date}}"). This module is pure and testable:
//   - extract / substitute / validate placeholders
//   - parse pasted CSV into value rows
//   - deep-clone a template page N times with substitutions applied
//
// The placeholders survive save/load untouched (they are just strings in the
// text field), so types.ts and validate.ts need no changes.
//
// BATCH CAP: a single batch run generates at most MAX_BATCH_VARIANTS pages.
// Rationale: each variant is a full page clone in the document JSON; beyond
// ~100 the document gets heavy, autosave payloads balloon, and the pages
// strip becomes unusable. Generating is draft-first — pages land as new
// drafts for human review, never auto-exported or published.

import {
  newId,
  type DesignDocument,
  type DesignElement,
  type DesignPage,
} from "./types";

/** Hard cap on variants generated in one batch run (see rationale above). */
export const MAX_BATCH_VARIANTS = 100;

/** A variable name is letters, digits, or underscores. */
const VARIABLE_NAME_RE = /^[a-zA-Z0-9_]+$/;

/** Global matcher for {{ name }} placeholders (whitespace around the name is ignored). */
const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// ── Extraction ───────────────────────────────────────────────────────────

/** Collect every text string that can carry a placeholder from a page or document. */
function collectTexts(source: DesignDocument | DesignPage): string[] {
  const pages = "elements" in source ? [source] : source.pages;
  const out: string[] = [];
  for (const page of pages) {
    for (const el of page.elements) {
      if (el.type === "text") {
        out.push(el.text);
        for (const f of el.fragments ?? []) out.push(f.text);
      }
    }
  }
  return out;
}

/**
 * Find all {{name}} placeholders in a doc, page, or raw string.
 * Returns variable names deduped, in order of first appearance.
 * Anything that isn't [a-zA-Z0-9_]+ inside the braces is ignored
 * (e.g. {{product name}}, {{}}, {{price-$}} never surface as variables).
 */
export function extractVariables(source: DesignDocument | DesignPage | string): string[] {
  const texts = typeof source === "string" ? [source] : collectTexts(source);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    VARIABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = VARIABLE_RE.exec(text)) !== null) {
      const name = m[1]!;
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

// ── Substitution ─────────────────────────────────────────────────────────

function hasOwn(values: Record<string, string>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(values, name);
}

/**
 * Replace {{name}} placeholders with values. Unknown variables are left
 * intact (never blanked silently — a missing value is visible, not hidden).
 */
export function substituteVariables(text: string, values: Record<string, string>): string {
  return text.replace(VARIABLE_RE, (full, name: string) =>
    hasOwn(values, name) ? values[name]! : full,
  );
}

/** Report which variables in `text` have no value supplied. */
export function validateSubstitution(
  text: string,
  values: Record<string, string>,
): { missing: string[] } {
  const missing: string[] = [];
  const seen = new Set<string>();
  VARIABLE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = VARIABLE_RE.exec(text)) !== null) {
    const name = m[1]!;
    if (!seen.has(name)) {
      seen.add(name);
      if (!hasOwn(values, name)) missing.push(name);
    }
  }
  return { missing };
}

// ── CSV parsing ──────────────────────────────────────────────────────────

/**
 * Small robust CSV parser: handles quoted fields, commas inside quotes,
 * escaped double-quotes (""), and \r\n line endings. Blank lines are
 * dropped (reported as skipped). Returns rows of raw cell strings.
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = "";
  };

  while (i < input.length) {
    const ch = input[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ",") {
      pushField();
      i += 1;
    } else if (ch === "\r") {
      i += 1; // \r\n handled at \n; lone \r is ignored
    } else if (ch === "\n") {
      pushField();
      rows.push(row);
      row = [];
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  // Trailing content without a final newline.
  if (field !== "" || row.length > 0 || inQuotes) {
    pushField();
    rows.push(row);
  }
  // Drop blank lines (every cell empty after trimming); they carry no values.
  return rows.filter((r) => r.some((cell) => cell.trim() !== ""));
}

export interface CsvImportResult {
  /** One value-row per data row; keys are the matched variable names. */
  rows: Record<string, string>[];
  /** Headers that matched no detected variable (ignored columns). */
  unmatchedHeaders: string[];
  /** Detected variables with no column (their values stay empty). */
  missingVariables: string[];
  /** Data rows skipped because a row was blank — parseCsv already drops them, so 0 here. */
  skipped: number;
}

/**
 * Map parsed CSV rows onto the detected variables. The first row is the
 * header row; headers are trimmed and matched exactly against variable
 * names. Only matched columns become values; extra columns are reported,
 * not silently dropped.
 */
export function csvToValueRows(csv: string, variables: string[]): CsvImportResult {
  const raw = parseCsv(csv);
  if (raw.length === 0) {
    return { rows: [], unmatchedHeaders: [], missingVariables: [...variables], skipped: 0 };
  }
  const varSet = new Set(variables);
  const headers = raw[0]!.map((h) => h.trim());
  const unmatchedHeaders = headers.filter(
    (h) => h !== "" && !(VARIABLE_NAME_RE.test(h) && varSet.has(h)),
  );
  const colVar: (string | null)[] = headers.map((h) =>
    VARIABLE_NAME_RE.test(h) && varSet.has(h) ? h : null,
  );
  const missingVariables = variables.filter((v) => !colVar.includes(v));
  // No usable column at all (e.g. values pasted without a header row):
  // surface the headers as unmatched and yield zero rows.
  if (!colVar.some((v) => v !== null)) {
    return { rows: [], unmatchedHeaders: headers.filter((h) => h !== ""), missingVariables, skipped: 0 };
  }
  const rows = raw.slice(1).map((cells) => {
    const values: Record<string, string> = {};
    colVar.forEach((v, idx) => {
      if (v !== null) values[v] = (cells[idx] ?? "").trim();
    });
    return values;
  });
  return { rows, unmatchedHeaders, missingVariables, skipped: 0 };
}

// ── Batch generation ─────────────────────────────────────────────────────

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Deep-clone an element, substitute variables in its text, and give it a fresh id. */
function cloneElementWithValues(el: DesignElement, values: Record<string, string>): DesignElement {
  const copy = deepClone(el);
  copy.id = newId("el");
  if (copy.type === "text") {
    copy.text = substituteVariables(copy.text, values);
    if (copy.fragments) {
      for (const f of copy.fragments) f.text = substituteVariables(f.text, values);
    }
  }
  return copy;
}

/**
 * Build up to MAX_BATCH_VARIANTS variant pages from a template page.
 * Each variant deep-clones the template, substitutes the row's values into
 * every text element (text + fragments), gets fresh page/element ids, and is
 * named "Variant 1", "Variant 2", … — ready for store.appendPages, which
 * treats them as drafts the human reviews. Rows beyond the cap are dropped
 * (the modal clamps before calling, so this is a backstop).
 */
export function buildBatchPages(
  templatePage: DesignPage,
  rows: Record<string, string>[],
): DesignPage[] {
  return rows.slice(0, MAX_BATCH_VARIANTS).map((values, i) => ({
    ...deepClone(templatePage),
    id: newId("page"),
    name: `Variant ${i + 1}`,
    elements: templatePage.elements.map((el) => cloneElementWithValues(el, values)),
  }));
}
