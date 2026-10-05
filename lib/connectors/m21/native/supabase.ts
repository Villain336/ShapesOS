// ShapesOS — Phase 11 (devtools): Supabase adapter (native, read-only v1).
//
// LIVE WIRING: a Supabase personal access token (supabase.com/dashboard/
// account/tokens) stored through the API-key vault; tools call the
// Management API (lib/connectors/m21/live/supabase.ts):
//   list_projects  GET  /v1/projects
//   list_buckets   GET  /v1/projects/{ref}/storage/buckets
//   run_sql        POST /v1/projects/{ref}/database/query — ONE read-only
//                  statement: SQL guard (lib/connectors/m21/live/sql-guard.ts)
//                  + READ ONLY transaction + statement timeout + row cap +
//                  Supabase's read-only role. DML/DDL/multi-statement queries
//                  are refused before any request.
// v1 has NO write tools (no inserts, migrations, bucket or project changes):
// a database the agent can only read is the safe default; writes would need
// their own gated tools and approval design. Tool group "data" (analysis).
// OAuth (Supabase OAuth apps) is not wired in v1; the PAT is the credential.
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected"): labelled "(MOCK)" rows; no network calls.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, type LiveDeps, type TokenSource } from "../live/http";
import { supabaseListBuckets, supabaseListProjects, supabaseRunReadOnlySql } from "../live/supabase";
import { SqlGuardError, assertReadOnlySql } from "../live/sql-guard";
import { inputFailure } from "./outlook";

/** The PAT from an API-key credential (or an OAuth access token). */
export function supabaseTokenFrom(credential: DecryptedCredential | null): TokenSource | null {
  const p = credential?.payload ?? {};
  const token = typeof p.apiKey === "string" && p.apiKey.trim() ? p.apiKey.trim() : typeof p.access_token === "string" ? p.access_token : "";
  return token ? { token } : null;
}

export class SupabaseAdapter implements ConnectorAdapter {
  readonly key = "supabase";
  readonly displayName = "Supabase";
  readonly authType = "api_key" as const;
  readonly configSchema = {
    type: "object",
    properties: { projectRef: { type: "string", description: "Default project ref for this project data source (optional)." } },
  };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_projects",
        description: "List the Supabase projects this token can see (ref, name, region, status).",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "list_buckets",
        description: "List the storage buckets of a Supabase project (name, public or private).",
        mutating: false,
        argsSchema: { type: "object", properties: { projectRef: strProp("Project ref (from list_projects); defaults to the data source's project.") } },
      },
      {
        name: "run_sql",
        description:
          "Run ONE read-only SQL query (SELECT / WITH / TABLE / VALUES) on a Supabase project's database and return the rows. Anything that writes or changes the database is refused.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            query: strProp("A single read-only SQL statement."),
            projectRef: strProp("Project ref (from list_projects); defaults to the data source's project."),
            maxRows: numProp("Row cap (default 200, max 1000)."),
          },
          required: ["query"],
        },
      },
    ];
  }

  private refFrom(args: Record<string, unknown>, ctx: InvokeContext): unknown {
    const a = typeof args.projectRef === "string" ? args.projectRef.trim() : "";
    return a || ctx.projectConfig?.projectRef;
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = supabaseTokenFrom(credential);
    if (!auth) return this.mock(tool, args);
    try {
      switch (tool) {
        case "list_projects":
          return liveOk(await supabaseListProjects(auth, this.deps));
        case "list_buckets":
          return liveOk(await supabaseListBuckets(auth, this.refFrom(args, ctx), this.deps));
        case "run_sql":
          return liveOk(await supabaseRunReadOnlySql(auth, { projectRef: this.refFrom(args, ctx), query: args.query, maxRows: args.maxRows }, this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      if (err instanceof SqlGuardError) return { ok: false, mock: false, errorCode: "bad_request", error: `Refused: ${err.message}` };
      return inputFailure(err, "Supabase");
    }
  }

  async healthCheck(credential: DecryptedCredential): Promise<InvokeResult> {
    const auth = supabaseTokenFrom(credential);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Supabase is not connected." };
    try {
      const projects = await supabaseListProjects(auth, this.deps);
      return liveOk({ reachable: true, projects: projects.length });
    } catch (err) {
      return liveFailure(err, "Supabase");
    }
  }

  /** Labelled mock (dev/test/demo). The SQL guard still applies. */
  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_projects":
        return mockOk([{ ref: "mockprojectrefaaaaaa", name: "Production (MOCK)", region: "eu-west-1", status: "ACTIVE_HEALTHY", organizationId: null, createdAt: null, mock: true }]);
      case "list_buckets":
        return mockOk([{ id: "avatars", name: "avatars (MOCK)", public: false, createdAt: null, mock: true }]);
      case "run_sql":
        try {
          assertReadOnlySql(args.query);
        } catch (err) {
          if (err instanceof SqlGuardError) return { ok: false, mock: true, errorCode: "bad_request", error: `Refused: ${err.message}` };
          throw err;
        }
        return mockOk({ rows: [{ count: 42, mock: true }], rowCount: 1, capped: false, truncated: false, info: "MOCK — Supabase is not connected; no query ran." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
