// ShapesOS — Phase 11 (devtools): Supabase Management API (personal access token).
//
//   GET  https://api.supabase.com/v1/projects                              → projects
//   GET  https://api.supabase.com/v1/projects/{ref}/storage/buckets        → storage buckets
//   POST https://api.supabase.com/v1/projects/{ref}/database/query         → run SQL
// Docs: supabase.com/docs/reference/api (Management API v1).
//
// READ-ONLY BY CONSTRUCTION (v1 has no write tools): run_sql only accepts a
// statement that passes the SQL guard (lib/connectors/m21/live/sql-guard.ts),
// wraps it in a READ ONLY transaction with a statement timeout and a row
// cap, and asks Supabase to run it as its read-only role (`read_only: true`).
// The token is a Supabase personal access token (sbp_…) from the vault; it
// never appears in errors (liveRequest scrubs it). No per-project
// service_role key is stored: every v1 tool works through the Management API,
// and a service_role key (which bypasses RLS) would only widen the blast
// radius.

import { clampInt, liveRequest, type LiveDeps, type TokenSource } from "./http";
import { assertReadOnlySql, readOnlyWrapped } from "./sql-guard";

export const SUPABASE_API = "https://api.supabase.com/v1";
const PROVIDER = "Supabase";
const MAX_ROWS = 1000;
const MAX_RESULT_CHARS = 200_000;

const REF_RE = /^[a-z]{20}$/;

export function projectRefOf(v: unknown): string {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) throw new Error("projectRef is required.");
  if (!REF_RE.test(s)) throw new Error("projectRef must be a Supabase project ref (20 lowercase letters, from list_projects).");
  return s;
}

export interface SupabaseProject {
  ref: string;
  name: string;
  region: string | null;
  status: string | null;
  organizationId: string | null;
  createdAt: string | null;
}

export async function supabaseListProjects(auth: TokenSource, deps: LiveDeps = {}): Promise<SupabaseProject[]> {
  const list = await liveRequest<Array<{ id?: string; ref?: string; name?: string; region?: string; status?: string; organization_id?: string; created_at?: string }>>(
    { provider: PROVIDER, url: `${SUPABASE_API}/projects`, auth },
    deps,
  );
  return (Array.isArray(list) ? list : []).map((p) => ({
    ref: String(p.ref ?? p.id ?? ""),
    name: String(p.name ?? ""),
    region: p.region ?? null,
    status: p.status ?? null,
    organizationId: p.organization_id ?? null,
    createdAt: p.created_at ?? null,
  }));
}

export async function supabaseListBuckets(
  auth: TokenSource,
  ref: unknown,
  deps: LiveDeps = {},
): Promise<Array<{ id: string; name: string; public: boolean; createdAt: string | null }>> {
  const projectRef = projectRefOf(ref);
  const list = await liveRequest<Array<{ id?: string; name?: string; public?: boolean; created_at?: string }>>(
    { provider: PROVIDER, url: `${SUPABASE_API}/projects/${projectRef}/storage/buckets`, auth },
    deps,
  );
  return (Array.isArray(list) ? list : []).map((b) => ({
    id: String(b.id ?? ""),
    name: String(b.name ?? ""),
    public: b.public === true,
    createdAt: b.created_at ?? null,
  }));
}

/**
 * Run one guarded read-only query. Returns the rows (≤ maxRows), whether the
 * cap was reached, and the statement that ran. Refusals throw SqlGuardError
 * before any request is made. The query is a read, so a 429/5xx is retried.
 */
export async function supabaseRunReadOnlySql(
  auth: TokenSource,
  opts: { projectRef?: unknown; query?: unknown; maxRows?: unknown },
  deps: LiveDeps = {},
): Promise<{ rows: unknown[]; rowCount: number; capped: boolean; truncated: boolean }> {
  const projectRef = projectRefOf(opts.projectRef);
  const statement = assertReadOnlySql(opts.query);
  const maxRows = clampInt(opts.maxRows, 200, 1, MAX_ROWS);
  const res = await liveRequest<unknown>(
    {
      provider: PROVIDER,
      url: `${SUPABASE_API}/projects/${projectRef}/database/query`,
      method: "POST",
      json: { query: readOnlyWrapped(statement, { maxRows, timeoutMs: 15_000 }), read_only: true },
      auth,
    },
    deps,
  );
  const rows = Array.isArray(res) ? res : [];
  // Keep the agent-facing payload bounded even for wide rows.
  let size = 0;
  const kept: unknown[] = [];
  for (const r of rows) {
    size += JSON.stringify(r ?? null).length;
    if (size > MAX_RESULT_CHARS) break;
    kept.push(r);
  }
  return { rows: kept, rowCount: rows.length, capped: rows.length >= maxRows, truncated: kept.length < rows.length };
}
