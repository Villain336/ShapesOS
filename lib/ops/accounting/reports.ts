// ShapesOS — Phase 10 (finance): trial balance, profit & loss, balance sheet.
//
// The maths is PURE (account list + per-account debit/credit sums in, report
// out) and unit-tested; loadAccountSums() is the only DB read: one grouped
// aggregate over ops_journal_lines for the date range, inside the caller's
// workspace scope.
//
//   trial balance  every account's net balance on its natural side; the
//                  debit and credit columns always total the same.
//   P&L            income (credit − debit) and expenses (debit − credit) in
//                  [from, to]; net income = income − expenses.
//   balance sheet  as of a date: assets = liabilities + equity, where equity
//                  includes current earnings (all income − expenses to date).

import type { Prisma } from "@prisma/client";
import { isDebitNormal, listAccounts, type AccountRow, type AccountType } from "./chart";

type Tx = Prisma.TransactionClient;

export interface AccountSums {
  debitCents: number;
  creditCents: number;
}

export type SumsByAccount = ReadonlyMap<string, AccountSums>;

export interface ReportRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  /** Net balance on the account's natural side (may be negative). */
  balanceCents: number;
}

const ZERO: AccountSums = { debitCents: 0, creditCents: 0 };

function naturalBalance(type: AccountType, s: AccountSums): number {
  return isDebitNormal(type) ? s.debitCents - s.creditCents : s.creditCents - s.debitCents;
}

function rowsOf(accounts: AccountRow[], sums: SumsByAccount, types: AccountType[], includeZero: boolean): ReportRow[] {
  return accounts
    .filter((a) => types.includes(a.type))
    .map((a) => ({
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      balanceCents: naturalBalance(a.type, sums.get(a.id) ?? ZERO),
    }))
    .filter((r) => includeZero || r.balanceCents !== 0 || (sums.get(r.accountId)?.debitCents ?? 0) !== 0);
}

const sum = (rows: Array<{ balanceCents: number }>) => rows.reduce((s, r) => s + r.balanceCents, 0);

// ---------------------------------------------------------------------------
// Trial balance
// ---------------------------------------------------------------------------

export interface TrialBalanceRow {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  debitCents: number;
  creditCents: number;
}

export interface TrialBalance {
  rows: TrialBalanceRow[];
  totalDebitCents: number;
  totalCreditCents: number;
  balanced: boolean;
}

export function trialBalance(accounts: AccountRow[], sums: SumsByAccount): TrialBalance {
  const rows: TrialBalanceRow[] = [];
  for (const a of accounts) {
    const s = sums.get(a.id);
    if (!s || (s.debitCents === 0 && s.creditCents === 0)) continue;
    const net = s.debitCents - s.creditCents;
    rows.push({
      accountId: a.id,
      code: a.code,
      name: a.name,
      type: a.type,
      debitCents: net > 0 ? net : 0,
      creditCents: net < 0 ? -net : 0,
    });
  }
  const totalDebitCents = rows.reduce((t, r) => t + r.debitCents, 0);
  const totalCreditCents = rows.reduce((t, r) => t + r.creditCents, 0);
  return { rows, totalDebitCents, totalCreditCents, balanced: totalDebitCents === totalCreditCents };
}

// ---------------------------------------------------------------------------
// Profit and loss
// ---------------------------------------------------------------------------

export interface ProfitAndLoss {
  income: ReportRow[];
  expenses: ReportRow[];
  totalIncomeCents: number;
  totalExpenseCents: number;
  netIncomeCents: number;
}

export function profitAndLoss(accounts: AccountRow[], sums: SumsByAccount): ProfitAndLoss {
  const income = rowsOf(accounts, sums, ["income"], false);
  const expenses = rowsOf(accounts, sums, ["expense"], false);
  const totalIncomeCents = sum(income);
  const totalExpenseCents = sum(expenses);
  return { income, expenses, totalIncomeCents, totalExpenseCents, netIncomeCents: totalIncomeCents - totalExpenseCents };
}

// ---------------------------------------------------------------------------
// Balance sheet
// ---------------------------------------------------------------------------

export interface BalanceSheet {
  assets: ReportRow[];
  liabilities: ReportRow[];
  equity: ReportRow[];
  totalAssetsCents: number;
  totalLiabilitiesCents: number;
  /** Equity accounts + current earnings. */
  totalEquityCents: number;
  /** Income − expenses to date (not yet closed to retained earnings). */
  currentEarningsCents: number;
  balanced: boolean;
}

export function balanceSheet(accounts: AccountRow[], sums: SumsByAccount): BalanceSheet {
  const assets = rowsOf(accounts, sums, ["asset"], false);
  const liabilities = rowsOf(accounts, sums, ["liability"], false);
  const equity = rowsOf(accounts, sums, ["equity"], false);
  const pl = profitAndLoss(accounts, sums);
  const totalAssetsCents = sum(assets);
  const totalLiabilitiesCents = sum(liabilities);
  const totalEquityCents = sum(equity) + pl.netIncomeCents;
  return {
    assets,
    liabilities,
    equity,
    totalAssetsCents,
    totalLiabilitiesCents,
    totalEquityCents,
    currentEarningsCents: pl.netIncomeCents,
    balanced: totalAssetsCents === totalLiabilitiesCents + totalEquityCents,
  };
}

// ---------------------------------------------------------------------------
// DB loader + report entry points
// ---------------------------------------------------------------------------

export async function loadAccountSums(
  tx: Tx,
  workspaceId: string,
  range: { from?: Date; to?: Date },
): Promise<Map<string, AccountSums>> {
  const where: Prisma.OpsJournalLineWhereInput = { workspaceId };
  if (range.from || range.to) {
    where.entryDate = { ...(range.from ? { gte: range.from } : {}), ...(range.to ? { lte: range.to } : {}) };
  }
  const grouped = await tx.opsJournalLine.groupBy({
    by: ["accountId"],
    where,
    _sum: { debitCents: true, creditCents: true },
  });
  return new Map(
    grouped.map((g) => [g.accountId, { debitCents: g._sum.debitCents ?? 0, creditCents: g._sum.creditCents ?? 0 }]),
  );
}

export type ReportKind = "trial_balance" | "profit_and_loss" | "balance_sheet";

export interface ReportRange {
  from?: Date;
  /** Inclusive end; for the balance sheet this is the "as of" date. */
  to?: Date;
}

/** End-of-day for a YYYY-MM-DD bound, so "to=2026-10-31" covers the 31st. */
export function parseReportDate(v: string | null | undefined, endOfDay: boolean): Date | undefined {
  if (!v) return undefined;
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`) : new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function runReport(
  tx: Tx,
  workspaceId: string,
  kind: ReportKind,
  range: ReportRange,
): Promise<TrialBalance | ProfitAndLoss | BalanceSheet> {
  const accounts = await listAccounts(tx, workspaceId);
  if (kind === "profit_and_loss") {
    return profitAndLoss(accounts, await loadAccountSums(tx, workspaceId, range));
  }
  // Trial balance and balance sheet are cumulative to the end date.
  const sums = await loadAccountSums(tx, workspaceId, { to: range.to });
  return kind === "trial_balance" ? trialBalance(accounts, sums) : balanceSheet(accounts, sums);
}
