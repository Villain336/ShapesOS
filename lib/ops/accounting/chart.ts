// ShapesOS — Phase 10 (finance): the chart of accounts.
//
// A standard small-business chart is seeded per workspace on first use
// (ensureChartOfAccounts — idempotent, ON CONFLICT DO NOTHING, so two
// concurrent first uses converge). systemKey marks the accounts the posting
// rules address; people can rename them, add sub-accounts (parentId) and
// deactivate the ones they don't use. Account codes are unique per workspace.

import type { Prisma } from "@prisma/client";
import { OpsError } from "../doctype";
import type { SystemAccountKey } from "./rules";

type Tx = Prisma.TransactionClient;
export type AccountType = "asset" | "liability" | "equity" | "income" | "expense";

export interface ChartSeed {
  code: string;
  name: string;
  type: AccountType;
  systemKey?: SystemAccountKey;
}

export const STANDARD_CHART: readonly ChartSeed[] = [
  { code: "1000", name: "Cash and bank", type: "asset", systemKey: "cash" },
  // Phase 12 (mfgpos): card takings waiting for the processor's payout.
  { code: "1050", name: "Card payments clearing", type: "asset", systemKey: "card_clearing" },
  { code: "1100", name: "Accounts receivable", type: "asset", systemKey: "ar" },
  { code: "1200", name: "Inventory", type: "asset", systemKey: "inventory" },
  // Phase 12 (mfgpos): manufactured goods and production in progress.
  { code: "1210", name: "Finished goods", type: "asset", systemKey: "finished_goods" },
  { code: "1250", name: "Work in progress", type: "asset", systemKey: "wip" },
  { code: "1300", name: "Input tax receivable", type: "asset", systemKey: "tax_receivable" },
  { code: "1500", name: "Equipment", type: "asset" },
  { code: "2000", name: "Accounts payable", type: "liability", systemKey: "ap" },
  { code: "2100", name: "Sales tax payable", type: "liability", systemKey: "tax_payable" },
  { code: "2200", name: "Reimbursements payable", type: "liability", systemKey: "reimbursements_payable" },
  { code: "2500", name: "Loans payable", type: "liability" },
  { code: "3000", name: "Owner's equity", type: "equity", systemKey: "owner_equity" },
  { code: "3900", name: "Retained earnings", type: "equity", systemKey: "retained_earnings" },
  { code: "4000", name: "Sales", type: "income", systemKey: "sales" },
  { code: "4100", name: "Service revenue", type: "income" },
  { code: "4900", name: "Other income", type: "income" },
  { code: "5000", name: "Cost of goods sold", type: "expense", systemKey: "cogs" },
  // Phase 12 (mfgpos): labour moved into product cost (credit balance), and
  // scrapped goods.
  { code: "5100", name: "Labour absorbed into production", type: "expense", systemKey: "labour_absorbed" },
  { code: "5200", name: "Scrap and waste", type: "expense", systemKey: "scrap_loss" },
  { code: "6000", name: "General expenses", type: "expense", systemKey: "expense_general" },
  { code: "6100", name: "Rent", type: "expense", systemKey: "expense_rent" },
  { code: "6150", name: "Utilities", type: "expense", systemKey: "expense_utilities" },
  { code: "6200", name: "Software and subscriptions", type: "expense", systemKey: "expense_software" },
  { code: "6300", name: "Travel", type: "expense", systemKey: "expense_travel" },
  { code: "6350", name: "Meals", type: "expense", systemKey: "expense_meals" },
  { code: "6400", name: "Office supplies", type: "expense", systemKey: "expense_office" },
  { code: "6500", name: "Professional fees", type: "expense", systemKey: "expense_professional" },
  { code: "6600", name: "Advertising and marketing", type: "expense", systemKey: "expense_advertising" },
  { code: "6900", name: "Bank fees", type: "expense", systemKey: "expense_bank_fees" },
  // Phase 12 (mfgpos): till counted vs expected.
  { code: "6950", name: "Cash over and short", type: "expense", systemKey: "cash_over_short" },
];

/** Accounts whose balance grows on the debit side. */
export function isDebitNormal(type: AccountType): boolean {
  return type === "asset" || type === "expense";
}

export interface AccountRow {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  systemKey: string | null;
  active: boolean;
}

/** Seed the standard chart when the workspace has no accounts yet. Idempotent. */
export async function ensureChartOfAccounts(tx: Tx, workspaceId: string): Promise<{ seeded: number }> {
  const count = await tx.opsAccount.count({ where: { workspaceId } });
  if (count > 0) return { seeded: 0 };
  const res = await tx.opsAccount.createMany({
    data: STANDARD_CHART.map((a) => ({
      workspaceId,
      code: a.code,
      name: a.name,
      type: a.type,
      systemKey: a.systemKey ?? null,
    })),
    skipDuplicates: true,
  });
  return { seeded: res.count };
}

export async function listAccounts(tx: Tx, workspaceId: string): Promise<AccountRow[]> {
  await ensureChartOfAccounts(tx, workspaceId);
  const rows = await tx.opsAccount.findMany({
    where: { workspaceId },
    orderBy: { code: "asc" },
    select: { id: true, code: true, name: true, type: true, parentId: true, systemKey: true, active: true },
  });
  return rows as AccountRow[];
}

/**
 * Resolve system keys to account ids, seeding the chart (or a single missing
 * system account) on first use. A key whose standard code is taken by some
 * other account cannot be seeded: that is a 409 the owner fixes in Accounts.
 */
export async function resolveSystemAccounts(
  tx: Tx,
  workspaceId: string,
  keys: readonly SystemAccountKey[],
): Promise<Map<SystemAccountKey, string>> {
  const wanted = [...new Set(keys)];
  const out = new Map<SystemAccountKey, string>();
  if (wanted.length === 0) return out;
  await ensureChartOfAccounts(tx, workspaceId);
  const load = async () =>
    tx.opsAccount.findMany({
      where: { workspaceId, systemKey: { in: wanted } },
      select: { id: true, systemKey: true },
    });
  let found = await load();
  const missing = wanted.filter((k) => !found.some((f) => f.systemKey === k));
  if (missing.length > 0) {
    await tx.opsAccount.createMany({
      data: missing
        .map((k) => STANDARD_CHART.find((s) => s.systemKey === k))
        .filter((s): s is ChartSeed => Boolean(s))
        .map((s) => ({ workspaceId, code: s.code, name: s.name, type: s.type, systemKey: s.systemKey ?? null })),
      skipDuplicates: true,
    });
    found = await load();
  }
  for (const f of found) out.set(f.systemKey as SystemAccountKey, f.id);
  const still = wanted.filter((k) => !out.has(k));
  if (still.length > 0) {
    throw new OpsError(
      409,
      `The chart of accounts has no ${still.join(", ")} account. Add one in Accounting → Accounts (its standard code is in use).`,
    );
  }
  return out;
}
