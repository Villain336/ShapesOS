// ShapesOS — Phase 11 (bizsync): QuickBooks Online as an AccountingProvider
// for the shared engines (lib/bizsync/accounting/{export,contacts}.ts).
// Every create carries the engine's idempotency key as ?requestid=.

import type { LiveDeps } from "@/lib/connectors/m21/live/http";
import { ConnectorApiError } from "@/lib/connectors/m21/live/http";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { findLink, saveLink } from "../links";
import { idempotencyKey } from "../accounting/export";
import type { AccountingProvider, RemoteAccountRef, RemoteRef } from "../accounting/types";
import { qboCreate, qboQuery, qboQuote, type QboAuth } from "./api";
import { accountFromQbo, billToQbo, incomeItemName, journalToQbo, partyFromQbo, paymentToQbo, salesToQbo, type QboAccount, type QboParty } from "./map";

const PAGE = 100;

function refOf(r: { Id?: string; DocNumber?: string }, what: string): RemoteRef {
  if (!r.Id) throw new ConnectorApiError("QuickBooks", "provider_error", `QuickBooks returned no id for the ${what}.`);
  return { id: String(r.Id), number: r.DocNumber ?? null };
}

export function quickbooksProvider(workspaceId: string, auth: QboAuth, deps: LiveDeps = {}): AccountingProvider {
  /** One ShapesOS Service item per income account (cached in biz_sync_links "item"). */
  async function ensureIncomeItem(account: RemoteAccountRef): Promise<string> {
    const localKey = `income:${account.id}`;
    const cached = await withWorkspaceScope(workspaceId, (tx) => findLink(tx, workspaceId, "quickbooks", "item", { localId: localKey }));
    if (cached) return cached.remoteId;
    const name = incomeItemName(account.name);
    const found = await qboQuery<{ Item?: Array<{ Id?: string }> }>(auth, `select * from Item where Name = ${qboQuote(name)}`, deps);
    const id =
      found.Item?.[0]?.Id ??
      refOf(
        await qboCreate<{ Id?: string }>(auth, "item", { Name: name, Type: "Service", IncomeAccountRef: { value: account.id } }, idempotencyKey(workspaceId, "quickbooks", `item:${account.id}`, 1), deps),
        "sales item",
      ).id;
    await withWorkspaceScope(workspaceId, (tx) => saveLink(tx, workspaceId, "quickbooks", "item", String(id), localKey, { meta: { name } }, "push"));
    return String(id);
  }

  return {
    key: "quickbooks",
    label: "QuickBooks",
    async listAccounts() {
      const r = await qboQuery<{ Account?: QboAccount[] }>(auth, "select * from Account startposition 1 maxresults 1000", deps);
      return (r.Account ?? []).flatMap((a) => {
        const x = accountFromQbo(a);
        return x ? [x] : [];
      });
    },
    async findOrCreateParty(kind, p, key) {
      const entity = kind === "customer" ? "Customer" : "Vendor";
      const found = await qboQuery<Record<string, Array<{ Id?: string }> | undefined>>(auth, `select * from ${entity} where DisplayName = ${qboQuote(p.name)}`, deps);
      const hit = found[entity]?.[0]?.Id;
      if (hit) return String(hit);
      const created = await qboCreate<{ Id?: string }>(auth, entity.toLowerCase(), { DisplayName: p.name, ...(p.email ? { PrimaryEmailAddr: { Address: p.email } } : {}) }, key, deps);
      return refOf(created, kind).id;
    },
    async createSales(doc, key) {
      const items = new Map<string, string>();
      for (const l of doc.lines) if (!items.has(l.account.id)) items.set(l.account.id, await ensureIncomeItem(l.account));
      const entity = doc.kind === "invoice" ? "invoice" : "creditmemo";
      return refOf(await qboCreate(auth, entity, salesToQbo(doc, (id) => items.get(id)!), key, deps), doc.kind.replace("_", " "));
    },
    async createBill(doc, key) {
      return refOf(await qboCreate(auth, "bill", billToQbo(doc), key, deps), "bill");
    },
    async createPayment(doc, key) {
      const { entity, body } = paymentToQbo(doc);
      return refOf(await qboCreate(auth, entity, body, key, deps), "payment");
    },
    async createJournal(doc, key) {
      return refOf(await qboCreate(auth, "journalentry", journalToQbo(doc), key, deps), "journal entry");
    },
    async listParties(kind, page) {
      const entity = kind === "customer" ? "Customer" : "Vendor";
      const r = await qboQuery<Record<string, QboParty[] | undefined>>(auth, `select * from ${entity} startposition ${(page - 1) * PAGE + 1} maxresults ${PAGE}`, deps);
      const rows = r[entity] ?? [];
      return { parties: rows.flatMap((p) => { const x = partyFromQbo(p, kind); return x ? [x] : []; }), more: rows.length === PAGE };
    },
  };
}
