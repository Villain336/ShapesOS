// ShapesOS — Phase 9 (apps): record validation, filtering and display (PURE).
//
// Every record write is validated here against the entity's fields BEFORE
// it reaches the database (lib/apps/service.ts adds the checks that need a
// query: relation targets and files exist in this workspace).
//
// Versions: a record keeps keys its entity no longer declares (a field the
// app dropped in a later version). They are never validated or overwritten,
// only carried along, so a record written under v1 stays readable after v2
// is published. New writes may only use the current spec's fields.
//
// Values are JSON scalars: text/date/select/relation/file → string, number →
// number, money → integer minor units (cents), bool → boolean. Empty ("" or
// null) clears a field.

import type { EntitySpec, FieldSpec, FilterSpec, ViewSpec } from "./spec";

export type RecordValue = string | number | boolean;
export type RecordData = Record<string, RecordValue>;

/** Largest stored record (serialized JSON). */
export const RECORD_MAX_BYTES = 64 * 1024;
/** Largest absolute money / number value (keeps cents exact in a double). */
const NUMBER_ABS_MAX = 1e13;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type FieldCheck = { ok: true; value: RecordValue | undefined } | { ok: false; error: string };

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function validDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validate (and normalize) one value. Empty → { ok, value: undefined } (the
 * caller decides whether that breaks `required`).
 */
export function validateFieldValue(field: FieldSpec, raw: unknown): FieldCheck {
  if (isEmpty(raw)) return { ok: true, value: undefined };
  switch (field.type) {
    case "text": {
      if (typeof raw !== "string") return { ok: false, error: "must be text" };
      const v = field.format === "multiline" ? raw.replace(/\r\n/g, "\n").trim() : raw.trim();
      const max = field.maxLength ?? 10_000;
      if (v.length > max) return { ok: false, error: `must be at most ${max} characters` };
      if (field.minLength !== undefined && v.length < field.minLength) {
        return { ok: false, error: `must be at least ${field.minLength} characters` };
      }
      if (field.format === "email" && !EMAIL_RE.test(v)) return { ok: false, error: "must be an email address" };
      if (field.format === "url") {
        let ok = false;
        try {
          const u = new URL(v);
          ok = u.protocol === "https:" || u.protocol === "http:";
        } catch {
          ok = false;
        }
        if (!ok) return { ok: false, error: "must be an http(s) link" };
      }
      return { ok: true, value: v };
    }
    case "number":
    case "money": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
      if (!Number.isFinite(n)) return { ok: false, error: "must be a number" };
      if (field.type === "money" && !Number.isInteger(n)) return { ok: false, error: "must be whole cents" };
      if (Math.abs(n) > NUMBER_ABS_MAX) return { ok: false, error: "is too large" };
      if (field.min !== undefined && n < field.min) return { ok: false, error: `must be at least ${fmtBound(field, field.min)}` };
      if (field.max !== undefined && n > field.max) return { ok: false, error: `must be at most ${fmtBound(field, field.max)}` };
      return { ok: true, value: n };
    }
    case "date": {
      const v = typeof raw === "string" ? raw.trim().slice(0, 10) : "";
      if (!validDate(v)) return { ok: false, error: "must be a date (YYYY-MM-DD)" };
      return { ok: true, value: v };
    }
    case "bool": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true" || raw === "false") return { ok: true, value: raw === "true" };
      return { ok: false, error: "must be yes or no" };
    }
    case "select": {
      if (typeof raw !== "string" || !(field.options ?? []).includes(raw)) {
        return { ok: false, error: `must be one of: ${(field.options ?? []).join(", ")}` };
      }
      return { ok: true, value: raw };
    }
    case "relation":
    case "file": {
      if (typeof raw !== "string" || !ID_RE.test(raw.trim())) {
        return { ok: false, error: field.type === "file" ? "must be a file id" : "must be a record id" };
      }
      return { ok: true, value: raw.trim() };
    }
  }
}

function fmtBound(field: FieldSpec, n: number): string {
  return field.type === "money" ? formatMoney(n, field.currency) : String(n);
}

export interface RecordRefs {
  /** Relation values to check: the record must exist in this app under `target`. */
  relations: Array<{ field: string; target: string; id: string }>;
  /** File values to check: a live WorkspaceFile in this workspace. */
  files: Array<{ field: string; id: string }>;
}

export type RecordCheck =
  | { ok: true; data: RecordData; refs: RecordRefs }
  | { ok: false; errors: Record<string, string> };

/**
 * Validate a create (no `existing`) or an update (merged onto `existing`).
 * Unknown keys are refused; required fields must be set on the merged
 * result; keys an older version stored are carried over untouched.
 */
export function validateRecordData(
  entity: EntitySpec,
  input: unknown,
  opts: { existing?: Record<string, unknown> | null } = {},
): RecordCheck {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: { _: "record data must be an object of field values" } };
  }
  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  const errors: Record<string, string> = {};
  const data: RecordData = {};

  // Start from the stored record (update): current fields re-normalized,
  // older-version keys carried over as they are.
  for (const [k, v] of Object.entries(opts.existing ?? {})) {
    if (v === null || v === undefined) continue;
    if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") continue;
    data[k] = v;
  }

  for (const [k, raw] of Object.entries(input as Record<string, unknown>)) {
    const f = fields.get(k);
    if (!f) {
      errors[k] = `"${k}" is not a field of ${entity.label}`;
      continue;
    }
    const r = validateFieldValue(f, raw);
    if (!r.ok) {
      errors[k] = `${f.label} ${r.error}`;
      continue;
    }
    if (r.value === undefined) delete data[k];
    else data[k] = r.value;
  }

  for (const f of entity.fields) {
    if (f.required && data[f.key] === undefined && !errors[f.key]) errors[f.key] = `${f.label} is required`;
  }
  if (Object.keys(errors).length) return { ok: false, errors };

  if (JSON.stringify(data).length > RECORD_MAX_BYTES) {
    return { ok: false, errors: { _: `record is larger than ${RECORD_MAX_BYTES / 1024} KB` } };
  }

  const refs: RecordRefs = { relations: [], files: [] };
  for (const f of entity.fields) {
    const v = data[f.key];
    if (typeof v !== "string") continue;
    // Only values this write set (or re-set) are re-checked; carried-over
    // relations were checked when they were written.
    if (!Object.prototype.hasOwnProperty.call(input, f.key)) continue;
    if (f.type === "relation" && f.target) refs.relations.push({ field: f.key, target: f.target, id: v });
    if (f.type === "file") refs.files.push({ field: f.key, id: v });
  }
  return { ok: true, data, refs };
}

/** One-line summary of validation errors. */
export function recordErrorText(errors: Record<string, string>): string {
  return Object.values(errors).slice(0, 5).join("; ");
}

// ---------------------------------------------------------------------------
// Views: filter + sort (in memory over the scanned page of records)
// ---------------------------------------------------------------------------

export interface RecordRow {
  id: string;
  data: Record<string, unknown>;
  specVersion: number;
  createdAt: string | Date;
  updatedAt: string | Date;
  createdBy?: string;
}

function systemValue(row: RecordRow, key: string): string | undefined {
  if (key !== "createdAt" && key !== "updatedAt") return undefined;
  const v = row[key];
  return v instanceof Date ? v.toISOString() : String(v);
}

function valueOf(row: RecordRow, key: string): unknown {
  return systemValue(row, key) ?? row.data?.[key];
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { sensitivity: "base", numeric: true });
}

function coerceLike(sample: unknown, v: unknown, field?: FieldSpec): unknown {
  if (field?.type === "number" || field?.type === "money" || typeof sample === "number") {
    const n = typeof v === "number" ? v : Number(v);
    return Number.isFinite(n) ? n : v;
  }
  if (field?.type === "bool" || typeof sample === "boolean") return v === true || v === "true";
  return v;
}

export function matchesFilter(row: RecordRow, filter: FilterSpec, field?: FieldSpec): boolean {
  const v = valueOf(row, filter.field);
  const empty = isEmpty(v);
  switch (filter.op) {
    case "empty":
      return empty;
    case "not_empty":
      return !empty;
    case "contains":
      return !empty && String(v).toLowerCase().includes(String(filter.value ?? "").toLowerCase());
  }
  const want = coerceLike(v, filter.value, field);
  if (filter.op === "eq") return !empty && cmp(v, want) === 0;
  if (filter.op === "neq") return empty || cmp(v, want) !== 0;
  if (empty) return false;
  const c = cmp(v, want);
  switch (filter.op) {
    case "gt":
      return c > 0;
    case "gte":
      return c >= 0;
    case "lt":
      return c < 0;
    case "lte":
      return c <= 0;
  }
  return false;
}

export interface ViewQuery {
  filters?: FilterSpec[];
  sort?: ViewSpec["sort"];
  /** Free-text search over text / select values. */
  q?: string;
}

/** Apply a view's (and the person's extra) filters, search and sort. Empty values sort last. */
export function applyViewQuery<T extends RecordRow>(rows: T[], entity: EntitySpec, query: ViewQuery): T[] {
  const fields = new Map(entity.fields.map((f) => [f.key, f]));
  let out = rows.filter((r) => (query.filters ?? []).every((f) => matchesFilter(r, f, fields.get(f.field))));
  const q = query.q?.trim().toLowerCase();
  if (q) {
    const searchable = entity.fields.filter((f) => f.type === "text" || f.type === "select").map((f) => f.key);
    out = out.filter((r) => searchable.some((k) => String(r.data?.[k] ?? "").toLowerCase().includes(q)));
  }
  const sort = query.sort;
  if (sort) {
    const dir = sort.dir === "asc" ? 1 : -1;
    out = [...out].sort((a, b) => {
      const va = valueOf(a, sort.field);
      const vb = valueOf(b, sort.field);
      const ea = isEmpty(va);
      const eb = isEmpty(vb);
      if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
      return cmp(va, vb) * dir;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

export function formatMoney(cents: number, currency = "USD"): string {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Plain-text rendering of a stored value (relation/file ids are resolved by the caller). */
export function formatValue(field: FieldSpec | undefined, v: unknown): string {
  if (isEmpty(v)) return "";
  if (!field) return String(v);
  switch (field.type) {
    case "money":
      return typeof v === "number" ? formatMoney(v, field.currency) : String(v);
    case "bool":
      return v === true ? "Yes" : v === false ? "No" : String(v);
    case "number":
      return typeof v === "number" ? v.toLocaleString("en-US") : String(v);
    default:
      return String(v);
  }
}

/** Keys a record stores that its entity (in this spec version) no longer declares. */
export function orphanKeys(entity: EntitySpec, data: Record<string, unknown>): string[] {
  const known = new Set(entity.fields.map((f) => f.key));
  return Object.keys(data ?? {}).filter((k) => !known.has(k));
}

/** Parse a money input typed by a person ("1,234.50") into cents; null when it isn't one. */
export function parseMoneyInput(s: string): number | null {
  const t = s.replace(/[,\s$€£]/g, "");
  if (!t) return null;
  if (!/^-?\d+(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ""] = t.replace("-", "").split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return t.startsWith("-") ? -cents : cents;
}
