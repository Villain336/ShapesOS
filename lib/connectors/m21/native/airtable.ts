// ShapesOS — Phase 11 (devtools): Airtable adapter (native).
//
// LIVE WIRING: Airtable OAuth (authorization code + PKCE; scopes
// data.records:read data.records:write schema.bases:read) → the vault
// credential; tools call the Airtable Web API (lib/connectors/m21/live/airtable.ts):
//   list_bases      meta/bases
//   list_tables     meta/bases/{base}/tables (fields included)
//   list_records    {base}/{table} (view / formula filter, offset pagination)
//   create_records  POST  {base}/{table}  ≤ 10 records   [mutating]
//   update_records  PATCH {base}/{table}  ≤ 10 records   [mutating]
// Requests are paced at 5/s per base; reads back off on 429, writes are
// never retried. Tool group "files" (bases are working documents, like
// Notion databases); writes map to the Tier-2 "connector_write" action
// (always ask).
//
// MOCK MODE (no credential; dev/test/demo only — production answers "not
// connected"): labelled "(MOCK)" rows; mock writes write nothing.

import type {
  ConnectorAdapter,
  ConnectorToolDef,
  DecryptedCredential,
  InvokeContext,
  InvokeResult,
} from "../types";
import { boolProp, fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, tokenSourceFrom } from "../live/http";
import { stickyAuth } from "../live/sticky-auth";
import {
  airtableCreateRecords,
  airtableListBases,
  airtableListRecords,
  airtableListTables,
  airtableUpdateRecords,
  airtableWhoAmI,
  type AirtableDeps,
} from "../live/airtable";
import { inputFailure } from "./outlook";

export class AirtableAdapter implements ConnectorAdapter {
  readonly key = "airtable";
  readonly displayName = "Airtable";
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(private readonly deps: AirtableDeps = {}) {}

  listTools(): ConnectorToolDef[] {
    const target = {
      baseId: strProp('Base id like "appXXXXXXXXXXXXXX" (from list_bases).'),
      table: strProp("Table id (tbl…) or table name (from list_tables)."),
    };
    return [
      {
        name: "list_bases",
        description: "List the Airtable bases this connection was granted (id, name, permission level).",
        mutating: false,
        argsSchema: { type: "object", properties: { limit: numProp("Max bases (default 100).") } },
      },
      {
        name: "list_tables",
        description: "List the tables of an Airtable base with their fields (name and type).",
        mutating: false,
        argsSchema: { type: "object", properties: { baseId: target.baseId }, required: ["baseId"] },
      },
      {
        name: "list_records",
        description: "List records of an Airtable table, optionally through a view or a filterByFormula.",
        mutating: false,
        argsSchema: {
          type: "object",
          properties: {
            ...target,
            view: strProp("View name or id (optional)."),
            filterByFormula: strProp('Airtable formula, e.g. {Status} = "Open" (optional).'),
            limit: numProp("Max records (default 100, max 1000)."),
            offset: strProp("nextOffset from a previous call, to continue."),
          },
          required: ["baseId", "table"],
        },
      },
      {
        name: "create_records",
        description: "Create up to 10 records in an Airtable table. Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            ...target,
            records: strProp('JSON array of field objects, e.g. [{"Name":"Launch post","Status":"Draft"}] (max 10).'),
            typecast: boolProp("Let Airtable convert values (e.g. create missing select options). Default false."),
          },
          required: ["baseId", "table", "records"],
        },
      },
      {
        name: "update_records",
        description: "Change fields on up to 10 existing Airtable records (other fields are left as they are). Asks for confirmation first.",
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            ...target,
            records: strProp('JSON array of {"id":"rec…","fields":{…}} (max 10).'),
            typecast: boolProp("Let Airtable convert values. Default false."),
          },
          required: ["baseId", "table", "records"],
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
    const source = tokenSourceFrom(credential, ctx);
    if (!source) return this.mock(tool, args);
    // Pagination makes several requests: keep a refreshed token for the rest.
    const auth = stickyAuth(source);
    try {
      switch (tool) {
        case "list_bases":
          return liveOk(await airtableListBases(auth, { limit: args.limit }, this.deps));
        case "list_tables":
          return liveOk(await airtableListTables(auth, args.baseId, this.deps));
        case "list_records":
          return liveOk(
            await airtableListRecords(
              auth,
              { baseId: args.baseId, table: args.table, view: args.view, filterByFormula: args.filterByFormula, limit: args.limit, offset: args.offset },
              this.deps,
            ),
          );
        case "create_records":
          return liveOk(await airtableCreateRecords(auth, { baseId: args.baseId, table: args.table, records: args.records, typecast: args.typecast }, this.deps));
        case "update_records":
          return liveOk(await airtableUpdateRecords(auth, { baseId: args.baseId, table: args.table, records: args.records, typecast: args.typecast }, this.deps));
        default:
          return fail(`Unknown tool "${tool}" for connector ${this.key}`);
      }
    } catch (err) {
      return inputFailure(err, "Airtable");
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const auth = tokenSourceFrom(credential, ctx);
    if (!auth) return { ok: false, errorCode: "not_connected", error: "Airtable is not connected." };
    try {
      return liveOk(await airtableWhoAmI(auth, this.deps));
    } catch (err) {
      return liveFailure(err, "Airtable");
    }
  }

  /** Labelled mock (dev/test/demo). Writes nothing. */
  private mock(tool: string, args: Record<string, unknown>): InvokeResult {
    switch (tool) {
      case "list_bases":
        return mockOk([{ id: "appMOCK0000000001", name: "Content calendar (MOCK)", permissionLevel: "create", mock: true }]);
      case "list_tables":
        return mockOk([{ id: "tblMOCK0000000001", name: "Posts (MOCK)", primaryFieldId: "fldMOCK0000000001", fields: [{ id: "fldMOCK0000000001", name: "Name", type: "singleLineText" }], mock: true }]);
      case "list_records":
        return mockOk({ records: [{ id: "recMOCK0000000001", createdTime: "2026-10-01T00:00:00.000Z", fields: { Name: "Launch post (MOCK)" }, mock: true }], nextOffset: null });
      case "create_records":
      case "update_records":
        return mockOk({ written: false, mock: true, table: String(args.table ?? ""), info: "MOCK — Airtable is not connected; nothing was written." });
      default:
        return fail(`Unknown tool "${tool}" for connector ${this.key}`);
    }
  }
}
