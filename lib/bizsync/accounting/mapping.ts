// ShapesOS — Phase 11 (bizsync): chart-of-accounts mapping, shared by
// QuickBooks Online and Xero (one ops_accounting_links table keyed by
// provider).
//
// suggestMapping() (PURE) proposes a remote account for every local one:
//   1. code   — same account code (QBO AcctNum / Xero Code) and same class;
//   2. system — the local account's posting role matches the provider's
//               marked account (ar → receivable, ap → payable, cash → the
//               first bank account, tax_payable → tax, retained earnings);
//   3. name   — same normalized name and class;
//   4. type   — last resort for the core posting roles only (sales → an
//               income account named like "sales" else the first income
//               account, cogs, general expense, owner's equity).
// Suggestions are stored as "suggested"; ONLY a person confirms them
// (confirmMapping, from Settings → Connectors → Business sync), and exports
// only ever use confirmed rows. A remote account of a different class can't
// be confirmed (an income account never maps to an asset).

import type { Prisma } from "@prisma/client";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { listAccounts, type AccountRow } from "@/lib/ops/accounting";
import type { AccountingProviderKey, LocalAccountClass, RemoteAccount, RemoteAccountRef } from "./types";

type Tx = Prisma.TransactionClient;

export type MatchReason = "code" | "system" | "name" | "type";

export interface Suggestion {
  accountId: string;
  remote: RemoteAccount | null;
  reason: MatchReason | null;
}

const norm = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();

const SYSTEM_ROLE: Partial<Record<string, RemoteAccount["role"]>> = {
  ar: "ar",
  ap: "ap",
  cash: "bank",
  tax_payable: "tax",
  retained_earnings: "retained",
};

function typeFallback(local: AccountRow, remote: RemoteAccount[]): RemoteAccount | null {
  const of = (cls: LocalAccountClass, re?: RegExp) => remote.find((r) => r.active && r.cls === cls && !r.role && (!re || re.test(norm(r.name))));
  switch (local.systemKey) {
    case "sales":
      return of("income", /\bsales\b/) ?? of("income") ?? null;
    case "cogs":
      return of("expense", /cost of (goods|sales)/) ?? null;
    case "expense_general":
      return of("expense", /\bgeneral\b/) ?? null;
    case "owner_equity":
      return of("equity", /\b(owner|capital)\b/) ?? null;
    default:
      return null;
  }
}

/** Propose one remote account per local account. PURE. */
export function suggestMapping(local: readonly AccountRow[], remote: readonly RemoteAccount[]): Suggestion[] {
  const active = remote.filter((r) => r.active);
  return local.map((a) => {
    const byCode = active.find((r) => r.code && r.code === a.code && r.cls === a.type);
    if (byCode) return { accountId: a.id, remote: byCode, reason: "code" };
    const role = a.systemKey ? SYSTEM_ROLE[a.systemKey] : undefined;
    const bySystem = role ? active.find((r) => r.role === role) : undefined;
    if (bySystem) return { accountId: a.id, remote: bySystem, reason: "system" };
    const byName = active.find((r) => r.cls === a.type && norm(r.name) === norm(a.name));
    if (byName) return { accountId: a.id, remote: byName, reason: "name" };
    const byType = typeFallback(a, active);
    if (byType) return { accountId: a.id, remote: byType, reason: "type" };
    return { accountId: a.id, remote: null, reason: null };
  });
}

export interface MappingRow {
  account: AccountRow;
  link: { remoteAccountId: string; remoteCode: string | null; remoteName: string; remoteType: string | null; status: string; matchReason: string | null; confirmedAt: Date | null } | null;
}

/** Local chart + current links (no remote call). */
export async function mappingRows(workspaceId: string, provider: AccountingProviderKey): Promise<MappingRow[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const accounts = await listAccounts(tx, workspaceId);
    const links = await tx.opsAccountingLink.findMany({ where: { workspaceId, provider } });
    const byAccount = new Map(links.map((l) => [l.accountId, l]));
    return accounts.map((account) => {
      const l = byAccount.get(account.id);
      return {
        account,
        link: l ? { remoteAccountId: l.remoteAccountId, remoteCode: l.remoteCode, remoteName: l.remoteName, remoteType: l.remoteType, status: l.status, matchReason: l.matchReason, confirmedAt: l.confirmedAt } : null,
      };
    });
  });
}

/** Store suggestions for accounts that have no confirmed mapping yet. Returns how many were (re)suggested. */
export async function saveSuggestions(workspaceId: string, provider: AccountingProviderKey, remote: readonly RemoteAccount[]): Promise<number> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const accounts = (await listAccounts(tx, workspaceId)).filter((a) => a.active);
    const confirmed = new Set((await tx.opsAccountingLink.findMany({ where: { workspaceId, provider, status: "confirmed" }, select: { accountId: true } })).map((l) => l.accountId));
    let n = 0;
    for (const s of suggestMapping(accounts, remote)) {
      if (confirmed.has(s.accountId)) continue;
      if (!s.remote) {
        await tx.opsAccountingLink.deleteMany({ where: { workspaceId, provider, accountId: s.accountId, status: "suggested" } });
        continue;
      }
      const data = { remoteAccountId: s.remote.id, remoteCode: s.remote.code, remoteName: s.remote.name.slice(0, 200), remoteType: s.remote.type.slice(0, 60), status: "suggested", matchReason: s.reason };
      await tx.opsAccountingLink.upsert({
        where: { workspaceId_provider_accountId: { workspaceId, provider, accountId: s.accountId } },
        create: { workspaceId, provider, accountId: s.accountId, ...data },
        update: data,
      });
      n += 1;
    }
    return n;
  });
}

export class MappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MappingError";
  }
}

/**
 * A person confirms (or clears, remoteAccountId null) mappings. Remote ids
 * are checked against the provider's live chart; classes must agree.
 */
export async function confirmMapping(
  workspaceId: string,
  provider: AccountingProviderKey,
  entries: ReadonlyArray<{ accountId: string; remoteAccountId: string | null }>,
  remote: readonly RemoteAccount[],
  userId: string,
): Promise<{ confirmed: number; cleared: number }> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const accounts = await listAccounts(tx, workspaceId);
    let confirmed = 0;
    let cleared = 0;
    for (const e of entries) {
      const a = accounts.find((x) => x.id === e.accountId);
      if (!a) throw new MappingError(`Account ${e.accountId} is not in this workspace's chart.`);
      if (e.remoteAccountId === null) {
        cleared += (await tx.opsAccountingLink.deleteMany({ where: { workspaceId, provider, accountId: a.id } })).count;
        continue;
      }
      const r = remote.find((x) => x.id === e.remoteAccountId);
      if (!r) throw new MappingError(`The ${provider} account ${e.remoteAccountId} was not found (refresh the account list).`);
      if (!r.active) throw new MappingError(`The ${provider} account "${r.name}" is archived.`);
      if (r.cls !== a.type) throw new MappingError(`"${a.code} ${a.name}" is ${a.type === "asset" || a.type === "expense" || a.type === "income" ? "an" : "a"} ${a.type} account; "${r.name}" is ${r.cls}.`);
      const data = { remoteAccountId: r.id, remoteCode: r.code, remoteName: r.name.slice(0, 200), remoteType: r.type.slice(0, 60), status: "confirmed", confirmedBy: userId, confirmedAt: new Date() };
      await tx.opsAccountingLink.upsert({
        where: { workspaceId_provider_accountId: { workspaceId, provider, accountId: a.id } },
        create: { workspaceId, provider, accountId: a.id, ...data },
        update: data,
      });
      confirmed += 1;
    }
    return { confirmed, cleared };
  });
}

/** Confirmed mappings: local account id → remote account. */
export async function confirmedMap(tx: Tx, workspaceId: string, provider: AccountingProviderKey): Promise<Map<string, RemoteAccountRef>> {
  const rows = await tx.opsAccountingLink.findMany({ where: { workspaceId, provider, status: "confirmed" } });
  return new Map(rows.map((r) => [r.accountId, { id: r.remoteAccountId, code: r.remoteCode, name: r.remoteName }]));
}
