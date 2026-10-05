// ShapesOS — Phase 11 (conncore): HubSpot adapter (native, bidirectional).
//
// LIVE WIRING: HubSpot OAuth (scopes crm.objects.{contacts,companies,deals}
// .read/.write + oauth) → the vault credential; tools call HubSpot CRM v3
// (lib/hubspot/api.ts) and the sync engine (lib/hubspot/sync.ts):
//   list_records       GET /crm/v3/objects/{type}        (read)
//   sync_from_hubspot  pull into Ops CRM (OpsCompany / OpsContact / OpsDeal),
//                      idempotent through hubspot_sync_links  [mutating —
//                      it writes your CRM: Tier-2 write_crm_record, asks]
//   push_to_hubspot    create/update one local record in HubSpot
//                      [mutating — connector_write, always asks]
// The conflict rule (last writer wins by updatedAt, local-ahead kept, push
// of an older record refused unless force) is documented in lib/hubspot/sync.ts.
// The older Tier-W webhook ingest (/api/substrate/graph/webhooks/hubspot) and
// Composio's HubSpot toolkit are unchanged.
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected"): labelled "(MOCK)" records; mock sync/push write nothing.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { boolProp, fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, tokenSourceFrom, type LiveDeps } from "../live/http";
import { hubspotListPage } from "@/lib/hubspot/api";
import { inputFailure } from "./outlook";

const OBJECT_TYPES = { contact: "contacts", company: "companies", deal: "deals" } as const;

function objectTypeOf(v: unknown): keyof typeof OBJECT_TYPES {
  if (v === "contact" || v === "company" || v === "deal") return v;
  throw new Error('objectType must be "contact", "company" or "deal".');
}

export class HubspotAdapter implements ConnectorAdapter {
  readonly key = "hubspot";
  readonly displayName = "HubSpot";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: LiveDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_records",
        description: "List HubSpot contacts, companies or deals (first page, with their HubSpot ids).",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: { objectType: strProp('"contact", "company" or "deal".'), limit: numProp("Max records (default 25, max 100).") },
          required: ["objectType"],
        },
      },
      {
        name: "sync_from_hubspot",
        description:
          "Pull HubSpot companies, contacts and deals into the CRM (creates or updates contacts, companies and deals; never duplicates; reports conflicts). Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            objectTypes: strProp('Comma-separated subset of "company,contact,deal" (default all).'),
            maxPages: numProp("Pages of 100 per type (default 20)."),
          },
        },
      },
      {
        name: "push_to_hubspot",
        description:
          "Create or update one CRM contact, company or deal in HubSpot (and associate it to its linked company/contact). Refuses when HubSpot has newer changes unless force is set. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            objectType: strProp('"contact", "company" or "deal".'),
            localId: strProp("The CRM record id."),
            force: boolProp("Overwrite newer HubSpot changes (default false)."),
          },
          required: ["objectType", "localId"],
        },
      },
    ];
  }

  async invoke(
    tool: string,
    args: Record<string, unknown>,
    credential: DecryptedCredential | null,
    ctx: InvokeContext,
  ): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return this.mock(tool, args);
    try {
      switch (tool) {
        case "list_records": {
          const page = await hubspotListPage(auth, OBJECT_TYPES[objectTypeOf(args.objectType)], { limit: Number(args.limit) || 25 }, this.deps);
          return liveOk(page.results);
        }
        case "sync_from_hubspot": {
          const { pullFromHubspot } = await import("@/lib/hubspot/sync");
          const objectTypes =
            typeof args.objectTypes === "string" && args.objectTypes.trim()
              ? args.objectTypes.split(",").map((t) => objectTypeOf(t.trim()))
              : undefined;
          return liveOk(await pullFromHubspot(ctx.workspaceId, auth, { objectTypes, maxPages: Number(args.maxPages) || undefined, userId: ctx.userId }, this.deps));
        }
        case "push_to_hubspot": {
          const { pushToHubspot, HubspotSyncError } = await import("@/lib/hubspot/sync");
          try {
            return liveOk(
              await pushToHubspot(
                ctx.workspaceId,
                auth,
                { objectType: objectTypeOf(args.objectType), localId: String(args.localId ?? ""), force: args.force === true || args.force === "true" },
                this.deps,
              ),
            );
          } catch (err) {
            if (err instanceof HubspotSyncError) {
              return { ok: false, mock: false, errorCode: err.code === "conflict" ? "bad_request" : err.code, error: err.message };
            }
            throw err;
          }
        }
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "HubSpot");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "HubSpot is not connected." };
    try {
      const page = await hubspotListPage(auth, "contacts", { limit: 1 }, this.deps);
      return liveOk({ reachable: true, sample: page.results.length });
    } catch (err) {
      return liveFailure(err, "HubSpot");
    }
  }

  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_records":
        return mockOk([{ id: "101", properties: { email: "ada@example.com", firstname: "Ada (MOCK)" }, updatedAt: "2026-10-01T00:00:00Z", associations: {}, mock: true }]);
      case "sync_from_hubspot":
        return mockOk({ created: 0, updated: 0, linked: 0, unchanged: 0, localAhead: 0, conflicts: [], pages: 0, truncated: false, mock: true, info: "MOCK — HubSpot is not connected; nothing was synced." });
      case "push_to_hubspot":
        return mockOk({ pushed: false, mock: true, objectType: String(args.objectType ?? ""), info: "MOCK — HubSpot is not connected; nothing was pushed." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
