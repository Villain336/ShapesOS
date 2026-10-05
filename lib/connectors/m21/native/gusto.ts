// ShapesOS — Phase 14 (connectors): Gusto payroll adapter (native, OAuth2).
//
// LIVE WIRING: Gusto OAuth2 (lib/vault/oauth.ts "gusto"; GUSTO_ENVIRONMENT
// picks api.gusto-demo.com or api.gusto.com) → the Gusto App Integrations
// API (lib/bizsync/gusto/api.ts, docs cited there) and the payroll engine
// (lib/bizsync/gusto/payroll.ts):
//   list_employees        Gusto employees + the team member each is matched
//                         to (confirmed or suggested)  (read)
//   sync_employees        save email matches as SUGGESTIONS a person confirms
//                         on Settings → Connectors → Business sync  [mutating —
//                         write_gusto, Tier 2: asks unless an
//                         automation rule lets it run — no money moves]
//   send_payroll          write a computed pay run's hours into Gusto's open
//                         payroll for the same period (idempotent per run and
//                         figures; Gusto computes the taxes; the person
//                         submits it in Gusto)  [mutating —
//                         send_payroll_to_provider, TIER 3: never automated,
//                         always asks — TIER3_EXACT_KINDS]
//   sync_payroll_results  what Gusto computed for a sent run once it is
//                         processed (taxes, net, paid or not) next to the
//                         payslips — read only: a person applies them with
//                         "Sync results" on the pay run page  (read)
// Every run is logged in biz_sync_runs (Settings → Connectors → Business sync).
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected" via withNoFakesGuard): labelled "(MOCK)" data; nothing is sent,
// nothing is written.

import type { ConnectorAdapter, ConnectorToolDef, DecryptedCredential, InvokeContext, InvokeResult } from "../types";
import { fail, liveOk, mockOk, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import type { GustoAuth } from "@/lib/bizsync/gusto/api";

/** Gusto auth from a vault credential (null → mock mode). */
export function gustoAuthFrom(credential: DecryptedCredential | null, ctx?: Pick<InvokeContext, "refreshCredential">): GustoAuth | null {
  const src = tokenSourceFrom(credential, ctx);
  if (!src) return null;
  const company = credential?.payload?.company_uuid;
  return { ...src, companyUuid: typeof company === "string" && company ? company : null };
}

function payRunIdArg(args: Record<string, unknown>): string {
  const id = typeof args.payRunId === "string" ? args.payRunId.trim() : "";
  if (!id || id.length > 64) throw new Error("payRunId is required (the pay run's id)");
  return id;
}

export class GustoAdapter implements ConnectorAdapter {
  readonly key = "gusto";
  readonly displayName = "Gusto";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_employees",
        description: "List the Gusto company's employees and the team member each one is matched to.",
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "sync_employees",
        description: "Match Gusto employees to team members by email and save the matches as suggestions for a person to confirm on the Business sync page. Asks for confirmation first.",
        mutating: true,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "send_payroll",
        description:
          "Write a computed pay run's hours into Gusto's open payroll for the same period. Gusto then computes taxes and a person submits the payroll in Gusto. Never automated: always asks for confirmation first.",
        mutating: true,
        argsSchema: { type: "object", properties: { payRunId: strProp("The computed pay run's id.") }, required: ["payRunId"] },
      },
      {
        name: "sync_payroll_results",
        description: "Show what Gusto computed for a pay run that was sent to it (taxes, net pay, whether it was paid) next to the payslips. Read only — a person applies the results on the pay run page.",
        mutating: false,
        argsSchema: { type: "object", properties: { payRunId: strProp("The pay run's id.") }, required: ["payRunId"] },
      },
    ];
  }

  async invoke(tool: string, args: Record<string, unknown>, credential: DecryptedCredential | null, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = gustoAuthFrom(credential, ctx);
    if (!auth) return this.mock(tool);
    const ws = ctx.workspaceId;
    try {
      const engine = await import("@/lib/bizsync/gusto/payroll");
      switch (tool) {
        case "list_employees": {
          const v = await engine.gustoEmployeeView(ws, auth, this.deps);
          const nameOf = new Map(v.local.map((m) => [m.id, m.name]));
          return liveOk({
            employees: v.remote.map((e) => {
              const link = v.links.find((l) => l.remoteId === e.id);
              return { id: e.id, name: e.name, email: e.email, terminated: e.terminated, teamMember: link ? nameOf.get(link.localId) ?? link.localId : null, match: link ? (link.confirmed ? "confirmed" : "suggested") : null };
            }),
            unmatchedTeamMembers: v.local.filter((m) => !v.links.some((l) => l.localId === m.id)).map((m) => m.name),
            truncated: v.truncated,
          });
        }
        case "sync_employees":
          return liveOk(await engine.withGustoRun(ws, "sync_employees", ctx.userId, () => engine.suggestGustoLinks(ws, auth, ctx.userId, this.deps)));
        case "send_payroll": {
          const runId = payRunIdArg(args);
          // Reached only after the person confirmed this call (Tier 3 kind
          // send_payroll_to_provider — no automation rule can skip it).
          const r = await engine.withGustoRun(ws, "send_payroll", ctx.userId, () =>
            engine.sendPayRunToGusto(ws, runId, auth, { workspaceId: ws, userId: ctx.userId }, { kind: "confirmed_tool_call" }, this.deps),
          );
          return liveOk({ ...r, next: "Review and submit the payroll in Gusto, then use Sync results on the pay run page." });
        }
        case "sync_payroll_results": {
          const runId = payRunIdArg(args);
          return liveOk(await engine.previewPayRunFromGusto(ws, runId, auth, this.deps));
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      const { OpsError } = await import("@/lib/ops/doctype");
      if (err instanceof OpsError) return { ok: false, mock: false, errorCode: err.status === 404 ? "not_found" : "bad_request", error: err.message };
      if (err instanceof Error && /^payRunId is required/.test(err.message)) return { ok: false, mock: false, errorCode: "bad_request", error: err.message };
      return liveFailure(err, "Gusto");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = gustoAuthFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Gusto is not connected." };
    try {
      const { gustoCompanyUuid, gustoEnvironment } = await import("@/lib/bizsync/gusto/api");
      await gustoCompanyUuid({ ...auth, companyUuid: null }, this.deps);
      return liveOk({ reachable: true, environment: gustoEnvironment() });
    } catch (err) {
      return liveFailure(err, "Gusto");
    }
  }

  private mock(tool: string): InvokeResult {
    switch (tool) {
      case "list_employees":
        return mockOk({ employees: [{ id: "mock-employee-1", name: "Ada Example (MOCK)", email: "ada@example.com", terminated: false, teamMember: null, match: null, mock: true }], unmatchedTeamMembers: [], truncated: false });
      case "sync_employees":
        return mockOk({ suggested: 0, mock: true, info: "MOCK — Gusto is not connected; nothing was matched." });
      case "send_payroll":
        return mockOk({ sent: 0, mock: true, info: "MOCK — Gusto is not connected; nothing was sent." });
      case "sync_payroll_results":
        return mockOk({ processed: false, mock: true, info: "MOCK — Gusto is not connected; there are no results." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
