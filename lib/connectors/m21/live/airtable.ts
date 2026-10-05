// ShapesOS — Phase 11 (devtools): Airtable Web API (OAuth bearer token).
//
//   GET   https://api.airtable.com/v0/meta/bases                → bases (offset pagination)
//   GET   https://api.airtable.com/v0/meta/bases/{base}/tables  → tables + fields
//   GET   https://api.airtable.com/v0/{base}/{table}            → records (offset pagination)
//   POST  https://api.airtable.com/v0/{base}/{table}            → create ≤ 10 records  [write]
//   PATCH https://api.airtable.com/v0/{base}/{table}            → update ≤ 10 records  [write]
// Docs: airtable.com/developers/web/api (list bases, get base schema, list
// records, create records, update multiple records).
//
// RATE LIMITS: Airtable allows 5 requests per second per base and answers
// 429 when exceeded, asking clients to wait 30 seconds. Every request to a
// base is paced here (≥ 200 ms apart per base, per process); reads that still
// hit 429 back off (first retry after 30 s, then 60 s) through liveRequest;
// writes are NEVER retried (a retry could create the records twice) — the
// caller sees rate_limited and can ask again. A 10-record cap per write keeps
// every write a single atomic Airtable request.

import {
  ConnectorApiError,
  clampInt,
  liveRequest,
  type LiveDeps,
  type LiveRequest,
  type TokenSource,
} from "./http";

export const AIRTABLE_API = "https://api.airtable.com/v0";
const PROVIDER = "Airtable";
/** Minimum spacing between requests to one base (5 req/s). */
export const AIRTABLE_BASE_SPACING_MS = 200;
/** Airtable's documented wait after a 429. */
const AIRTABLE_RATE_WAIT_MS = 30_000;
const MAX_RECORDS_PER_WRITE = 10;

const lastRequestAt = new Map<string, number>();

/** Test seam: forget the per-base pacing clock. */
export function resetAirtablePacing(): void {
  lastRequestAt.clear();
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wait until this base may take another request (≥ 200 ms since the last). */
async function pace(key: string, deps: LiveDeps & { now?: () => number }): Promise<void> {
  const now = deps.now ?? Date.now;
  const last = lastRequestAt.get(key);
  const t = now();
  if (last !== undefined && t - last < AIRTABLE_BASE_SPACING_MS) {
    await (deps.sleep ?? defaultSleep)(AIRTABLE_BASE_SPACING_MS - (t - last));
  }
  lastRequestAt.set(key, Math.max(now(), (last ?? 0) + AIRTABLE_BASE_SPACING_MS));
  if (lastRequestAt.size > 5000) lastRequestAt.clear();
}

export type AirtableDeps = LiveDeps & { now?: () => number };

async function read<T>(paceKey: string, req: Omit<LiveRequest, "provider">, deps: AirtableDeps): Promise<T> {
  await pace(paceKey, deps);
  return liveRequest<T>(
    { provider: PROVIDER, ...req },
    { ...deps, baseDelayMs: deps.baseDelayMs ?? AIRTABLE_RATE_WAIT_MS, maxRetries: deps.maxRetries ?? 2 },
  );
}

async function write<T>(paceKey: string, req: Omit<LiveRequest, "provider">, deps: AirtableDeps): Promise<T> {
  await pace(paceKey, deps);
  return liveRequest<T>({ provider: PROVIDER, ...req }, { ...deps, maxRetries: 0 });
}

// --------------------------------------------------------------- input checks

const BASE_RE = /^app[A-Za-z0-9]{14}$/;
const RECORD_RE = /^rec[A-Za-z0-9]{14}$/;

export function baseIdOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error("baseId is required.");
  if (!BASE_RE.test(s)) throw new Error('baseId must be an Airtable base id like "appXXXXXXXXXXXXXX".');
  return s;
}

export function tableOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error("table is required.");
  if (s.length > 255 || /[\u0000-\u001f]/.test(s)) throw new Error("table must be a table id (tbl…) or name.");
  return s;
}

function recordIdOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!RECORD_RE.test(s)) throw new Error('each record id must be an Airtable record id like "recXXXXXXXXXXXXXX".');
  return s;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === "object" && !Array.isArray(v);
}

/** Records arg: a JSON array (or an already-parsed array) of 1–10 items. */
function recordsArg(v: unknown): unknown[] {
  let parsed: unknown = v;
  if (typeof v === "string") {
    try {
      parsed = JSON.parse(v);
    } catch {
      throw new Error("records must be a JSON array.");
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("records must be a non-empty JSON array.");
  if (parsed.length > MAX_RECORDS_PER_WRITE) throw new Error(`records must be at most ${MAX_RECORDS_PER_WRITE} per call (Airtable's per-request limit).`);
  return parsed;
}

function fieldsOf(v: unknown): Record<string, unknown> {
  if (!isPlainObject(v) || Object.keys(v).length === 0) throw new Error("each record's fields must be a non-empty object of field name → value.");
  if (JSON.stringify(v).length > 100_000) throw new Error("each record's fields must be under 100 KB.");
  return v;
}

// --------------------------------------------------------------- shapes

export interface AirtableRecord {
  id: string;
  createdTime: string | null;
  fields: Record<string, unknown>;
}

const toRecord = (r: { id?: string; createdTime?: string; fields?: Record<string, unknown> }): AirtableRecord => ({
  id: String(r.id ?? ""),
  createdTime: r.createdTime ?? null,
  fields: isPlainObject(r.fields) ? r.fields : {},
});

const recordsUrl = (baseId: string, table: string) => `${AIRTABLE_API}/${baseId}/${encodeURIComponent(table)}`;

// --------------------------------------------------------------- reads

export async function airtableWhoAmI(auth: TokenSource, deps: AirtableDeps = {}): Promise<{ id: string; scopes: string[] }> {
  const r = await read<{ id?: string; scopes?: string[] }>("meta", { url: `${AIRTABLE_API}/meta/whoami`, auth }, deps);
  return { id: String(r?.id ?? ""), scopes: Array.isArray(r?.scopes) ? r.scopes.map(String) : [] };
}

export async function airtableListBases(
  auth: TokenSource,
  opts: { limit?: unknown } = {},
  deps: AirtableDeps = {},
): Promise<Array<{ id: string; name: string; permissionLevel: string | null }>> {
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const out: Array<{ id: string; name: string; permissionLevel: string | null }> = [];
  let offset: string | undefined;
  do {
    const page = await read<{ bases?: Array<{ id?: string; name?: string; permissionLevel?: string }>; offset?: string }>(
      "meta",
      { url: `${AIRTABLE_API}/meta/bases`, query: { offset }, auth },
      deps,
    );
    for (const b of page?.bases ?? []) out.push({ id: String(b.id ?? ""), name: String(b.name ?? ""), permissionLevel: b.permissionLevel ?? null });
    offset = page?.offset || undefined;
  } while (offset && out.length < limit);
  return out.slice(0, limit);
}

export async function airtableListTables(
  auth: TokenSource,
  baseIdArg: unknown,
  deps: AirtableDeps = {},
): Promise<Array<{ id: string; name: string; primaryFieldId: string | null; fields: Array<{ id: string; name: string; type: string }> }>> {
  const baseId = baseIdOf(baseIdArg);
  const r = await read<{ tables?: Array<{ id?: string; name?: string; primaryFieldId?: string; fields?: Array<{ id?: string; name?: string; type?: string }> }> }>(
    baseId,
    { url: `${AIRTABLE_API}/meta/bases/${baseId}/tables`, auth },
    deps,
  );
  return (r?.tables ?? []).map((t) => ({
    id: String(t.id ?? ""),
    name: String(t.name ?? ""),
    primaryFieldId: t.primaryFieldId ?? null,
    fields: (t.fields ?? []).map((f) => ({ id: String(f.id ?? ""), name: String(f.name ?? ""), type: String(f.type ?? "") })),
  }));
}

/** Records of one table, following `offset` up to `limit` (max 1000). */
export async function airtableListRecords(
  auth: TokenSource,
  opts: { baseId?: unknown; table?: unknown; view?: unknown; filterByFormula?: unknown; limit?: unknown; offset?: unknown },
  deps: AirtableDeps = {},
): Promise<{ records: AirtableRecord[]; nextOffset: string | null }> {
  const baseId = baseIdOf(opts.baseId);
  const table = tableOf(opts.table);
  const limit = clampInt(opts.limit, 100, 1, 1000);
  const view = typeof opts.view === "string" && opts.view.trim() ? opts.view.trim().slice(0, 255) : undefined;
  const formula = typeof opts.filterByFormula === "string" && opts.filterByFormula.trim() ? opts.filterByFormula.trim().slice(0, 4000) : undefined;
  const records: AirtableRecord[] = [];
  let offset: string | undefined = typeof opts.offset === "string" && opts.offset.trim() ? opts.offset.trim().slice(0, 500) : undefined;
  do {
    const page = await read<{ records?: Array<{ id?: string; createdTime?: string; fields?: Record<string, unknown> }>; offset?: string }>(
      baseId,
      {
        url: recordsUrl(baseId, table),
        query: { pageSize: Math.min(100, limit - records.length), view, filterByFormula: formula, offset },
        auth,
      },
      deps,
    );
    for (const r of page?.records ?? []) records.push(toRecord(r));
    offset = page?.offset || undefined;
  } while (offset && records.length < limit);
  return { records: records.slice(0, limit), nextOffset: offset ?? null };
}

// --------------------------------------------------------------- writes (never retried)

export async function airtableCreateRecords(
  auth: TokenSource,
  opts: { baseId?: unknown; table?: unknown; records?: unknown; typecast?: unknown },
  deps: AirtableDeps = {},
): Promise<{ created: AirtableRecord[] }> {
  const baseId = baseIdOf(opts.baseId);
  const table = tableOf(opts.table);
  const records = recordsArg(opts.records).map((r) => ({ fields: fieldsOf(isPlainObject(r) && isPlainObject(r.fields) ? r.fields : r) }));
  const res = await write<{ records?: Array<{ id?: string; createdTime?: string; fields?: Record<string, unknown> }> }>(
    baseId,
    { url: recordsUrl(baseId, table), method: "POST", json: { records, typecast: opts.typecast === true || opts.typecast === "true" }, auth },
    deps,
  );
  const created = (res?.records ?? []).map(toRecord);
  if (created.length !== records.length) throw new ConnectorApiError(PROVIDER, "provider_error", "Airtable did not confirm every created record.");
  return { created };
}

export async function airtableUpdateRecords(
  auth: TokenSource,
  opts: { baseId?: unknown; table?: unknown; records?: unknown; typecast?: unknown },
  deps: AirtableDeps = {},
): Promise<{ updated: AirtableRecord[] }> {
  const baseId = baseIdOf(opts.baseId);
  const table = tableOf(opts.table);
  const records = recordsArg(opts.records).map((r) => {
    if (!isPlainObject(r)) throw new Error('each record must be { "id": "rec…", "fields": { … } }.');
    return { id: recordIdOf(r.id), fields: fieldsOf(r.fields) };
  });
  if (new Set(records.map((r) => r.id)).size !== records.length) throw new Error("each record id must be unique within one call.");
  const res = await write<{ records?: Array<{ id?: string; createdTime?: string; fields?: Record<string, unknown> }> }>(
    baseId,
    { url: recordsUrl(baseId, table), method: "PATCH", json: { records, typecast: opts.typecast === true || opts.typecast === "true" }, auth },
    deps,
  );
  return { updated: (res?.records ?? []).map(toRecord) };
}
