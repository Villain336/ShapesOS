// ShapesOS — Phase 10 (finance): the daily finance sweep for one workspace
// (POST /api/cron/finance). Each part runs in its own workspace-scoped
// transaction so one failure doesn't roll back the others.

import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { OpsActor } from "../doctype";
import { markOverdueInvoices } from "../invoices";
import { draftDueRecurringInvoices } from "./recurring";
import { expireQuotes } from "./quotes";

export interface FinanceSweepResult {
  workspaceId: string;
  drafted: number;
  expiredQuotes: number;
  overdue: number;
}

export async function runFinanceSweep(workspaceId: string, now = new Date()): Promise<FinanceSweepResult> {
  const actor: OpsActor = { workspaceId, userId: "cron:finance" };
  const recurring = await withWorkspaceScope(workspaceId, (tx) => draftDueRecurringInvoices(tx, actor, now));
  const expired = await withWorkspaceScope(workspaceId, (tx) => expireQuotes(tx, actor, now));
  const overdue = await withWorkspaceScope(workspaceId, (tx) => markOverdueInvoices(tx, actor));
  return {
    workspaceId,
    drafted: recurring.reduce((s, r) => s + r.drafted.length, 0),
    expiredQuotes: expired.length,
    overdue: overdue.swept,
  };
}
