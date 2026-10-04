// ShapesOS — Phase 11 (bizsync): the shared shape of the two accounting
// adapters (QuickBooks Online, Xero). Same three tools, same engines:
//   list_accounts       the provider's chart + how each local account maps
//                       (read; the mapping itself is confirmed by a person in
//                       Settings → Connectors → Business sync, never by an agent)
//   import_contacts     customers → CRM contacts, vendors/suppliers → vendors
//                       [mutating — write_crm_record, Tier 2, asks]
//   post_to_<provider>  export posted invoices, credit notes, bills,
//                       payments and journals, idempotent per source
//                       document [mutating — post_to_accounting, Tier 3:
//                       never automated, always asks]
// Runs are logged in biz_sync_runs. MOCK MODE (no credential; dev/test/demo
// only — production answers "not connected" via withNoFakesGuard) returns
// labelled mocks and writes nothing.

import type { ConnectorAdapter, ConnectorToolDef, DecryptedCredential, InvokeContext, InvokeResult } from "../types";
import { fail, liveOk, mockOk, numProp, strProp } from "../types";
import { liveFailure, type LiveDeps } from "../live/http";
import type { AccountingProvider, AccountingProviderKey } from "@/lib/bizsync/accounting/types";
import type { ExportDocType } from "@/lib/bizsync/accounting/export";
import { inputFailure } from "./outlook";

const DOC_TYPES: readonly ExportDocType[] = ["invoice", "credit_note", "bill", "payment", "bill_payment", "journal_entry"];

export function parseDocTypes(v: unknown): ExportDocType[] | undefined {
  if (typeof v !== "string" || !v.trim()) return undefined;
  const out = v.split(",").map((s) => s.trim().toLowerCase());
  for (const t of out) if (!(DOC_TYPES as readonly string[]).includes(t)) throw new Error(`types must be a comma-separated subset of ${DOC_TYPES.join(",")}`);
  return out as ExportDocType[];
}

export function parseSince(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) || Number.isNaN(Date.parse(v))) throw new Error("since must be a date (YYYY-MM-DD)");
  return new Date(`${v.trim()}T00:00:00Z`);
}

export abstract class AccountingAdapter implements ConnectorAdapter {
  abstract readonly key: AccountingProviderKey;
  abstract readonly displayName: string;
  readonly authType = "oauth2" as const;
  readonly configSchema = { type: "object", properties: {} };

  constructor(protected readonly deps: LiveDeps = {}) {}

  /**
   * The provider for a live credential, or null (→ mock mode). Loaded lazily
   * (like the HubSpot adapter): the registry's import graph stays free of
   * the DB-backed sync engines.
   */
  protected async providerFor(credential: DecryptedCredential | null, ctx: InvokeContext): Promise<AccountingProvider | null> {
    const { accountingProviderFrom } = await import("@/lib/bizsync/accounting/providers");
    return accountingProviderFrom(this.key, ctx.workspaceId, credential, ctx, this.deps);
  }

  protected get postTool(): string {
    return `post_to_${this.key}`;
  }

  listTools(): ConnectorToolDef[] {
    return [
      {
        name: "list_accounts",
        description: `List the ${this.displayName} chart of accounts and which local account each one is mapped to (mappings are confirmed in Settings → Connectors → Business sync).`,
        mutating: false,
        argsSchema: { type: "object", properties: {} },
      },
      {
        name: "import_contacts",
        description: `Import ${this.displayName} customers into CRM contacts and vendors into vendors (never duplicates; reports conflicts). Asks for confirmation first.`,
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            kinds: strProp('Comma-separated subset of "customer,vendor" (default both).'),
            maxPages: numProp("Pages of 100 per kind (default 20)."),
          },
        },
      },
      {
        name: this.postTool,
        description: `Post the books to ${this.displayName}: posted invoices, credit notes, bills, payments and journal entries not exported yet (each exactly once; accounts must be mapped first). Never automated — always asks.`,
        mutating: true,
        argsSchema: {
          type: "object",
          properties: {
            types: strProp(`Comma-separated subset of "${DOC_TYPES.join(",")}" (default all).`),
            since: strProp("Only entries dated on/after this day (YYYY-MM-DD)."),
            maxDocs: numProp("Documents per run (default 50, max 200)."),
          },
        },
      },
    ];
  }

  async invoke(tool: string, args: Record<string, unknown>, credential: DecryptedCredential | null, ctx: InvokeContext): Promise<InvokeResult> {
    const provider = await this.providerFor(credential, ctx);
    if (!provider) return this.mock(tool);
    const ws = ctx.workspaceId;
    try {
      const { recordRun } = await import("@/lib/bizsync/links");
      switch (tool) {
        case "list_accounts": {
          const { mappingRows } = await import("@/lib/bizsync/accounting/mapping");
          const [remote, rows] = await Promise.all([provider.listAccounts(), mappingRows(ws, this.key)]);
          return liveOk({
            accounts: remote.map((r) => ({ id: r.id, code: r.code, name: r.name, type: r.type, class: r.cls, active: r.active })),
            mapping: rows.map((m) => ({ local: `${m.account.code} ${m.account.name}`, remote: m.link ? m.link.remoteName : null, status: m.link?.status ?? "unmapped" })),
          });
        }
        case "import_contacts": {
          const { importParties } = await import("@/lib/bizsync/accounting/contacts");
          const kinds = typeof args.kinds === "string" && args.kinds.trim() ? args.kinds.split(",").map((s) => s.trim()) : undefined;
          if (kinds?.some((k) => k !== "customer" && k !== "vendor")) throw new Error('kinds must be "customer", "vendor" or both');
          return liveOk(await recordRun(ws, this.key, "import_contacts", ctx.userId, () => importParties(ws, provider, { kinds: kinds as Array<"customer" | "vendor"> | undefined, maxPages: Number(args.maxPages) || undefined })));
        }
        default: {
          if (tool !== this.postTool) return fail(`Unknown tool "${tool}" for connector ${this.key}`);
          const { exportToAccounting } = await import("@/lib/bizsync/accounting/export");
          const only = parseDocTypes(args.types);
          const since = parseSince(args.since);
          return liveOk(await recordRun(ws, this.key, "export", ctx.userId, () => exportToAccounting(ws, provider, { userId: ctx.userId, only, since, maxDocs: Number(args.maxDocs) || undefined })));
        }
      }
    } catch (err) {
      return inputFailure(err, this.displayName);
    }
  }

  async healthCheck(credential: DecryptedCredential, ctx: InvokeContext): Promise<InvokeResult> {
    const provider = await this.providerFor(credential, ctx);
    if (!provider) return { ok: false, errorCode: "not_connected", error: `${this.displayName} is not connected.` };
    try {
      return liveOk({ reachable: true, accounts: (await provider.listAccounts()).length });
    } catch (err) {
      return liveFailure(err, this.displayName);
    }
  }

  private mock(tool: string): InvokeResult {
    if (tool === "list_accounts") {
      return mockOk({ accounts: [{ id: "1", code: "4000", name: `Sales (MOCK ${this.displayName})`, type: "Income", class: "income", active: true }], mapping: [], mock: true });
    }
    if (tool === "import_contacts") return mockOk({ created: 0, updated: 0, conflicts: [], mock: true, info: `MOCK — ${this.displayName} is not connected; nothing was imported.` });
    if (tool === this.postTool) return mockOk({ exported: [], alreadyExported: 0, mock: true, info: `MOCK — ${this.displayName} is not connected; nothing was posted.` });
    return fail(`Unknown tool "${tool}" for connector ${this.key}`);
  }
}
