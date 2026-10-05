// ShapesOS — Phase 10 (finance): /dashboard/ops/expenses — company expense
// claims: yours, and the ones waiting for someone else's review. (The
// personal home-office tracker stays at /dashboard/wfh/expenses.)

import { Wallet } from "lucide-react";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { financePageActor } from "@/lib/ops/finance/page";
import { DataTable, Empty, FinanceHeader, Panel, Pill, cellCls, fmtDay, money, numCls, rowCls } from "@/components/ops-finance/kit";
import { ClaimActions, NewClaimButton } from "@/components/ops-finance/ExpensesClient";

export const dynamic = "force-dynamic";
export const metadata = { title: "Expenses — ShapesOS", description: "Company expense claims: submit, approve, reimburse." };

const STATE: Record<string, string> = { draft: "Draft", submitted: "Waiting for review", approved: "Approved", rejected: "Rejected", reimbursed: "Reimbursed" };

type ClaimRow = Awaited<ReturnType<typeof load>>[number];

async function load(workspaceId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.opsExpenseClaim.findMany({
      where: { workspaceId },
      orderBy: { createdAt: "desc" },
      take: 300,
      include: { lines: { select: { description: true, category: true, amountCents: true, receiptFileId: true } } },
    }),
  );
}

export default async function ExpensesPage() {
  const actor = await financePageActor();
  const claims = await load(actor.workspaceId);
  const mine = claims.filter((c) => c.claimantId === actor.userId);
  const toReview = actor.canEdit ? claims.filter((c) => c.claimantId !== actor.userId && (c.status === "submitted" || c.status === "approved")) : [];

  const table = (rows: ClaimRow[], showWho: boolean) => (
    <DataTable head={[{ label: "Claim" }, ...(showWho ? [{ label: "Claimant" }] : []), { label: "State" }, { label: "Submitted" }, { label: "Receipts", align: "right" as const }, { label: "Total", align: "right" as const }, { label: "" }]}>
      {rows.map((c) => {
        const label = c.number ? `${c.number} · ${c.title}` : c.title;
        return (
          <tr key={c.id} className={rowCls}>
            <td className={`${cellCls} max-w-[320px] truncate font-semibold`}>{label}</td>
            {showWho ? <td className={cellCls}>{c.claimantName ?? <span className="aos-mono text-xs">{c.claimantId.slice(0, 10)}</span>}</td> : null}
            <td className={cellCls}>
              <Pill>{STATE[c.status]}</Pill>
              {c.rejectedReason ? <span className="ml-2 text-sm text-muted">{c.rejectedReason}</span> : null}
            </td>
            <td className={`${cellCls} tabular-nums text-muted`}>{fmtDay(c.submittedAt)}</td>
            <td className={numCls}>
              {c.lines.filter((l) => l.receiptFileId).length} of {c.lines.length}
            </td>
            <td className={numCls}>{money(c.totalCents)}</td>
            <td className={`${cellCls} text-right`}>
              {actor.canEdit ? (
                <ClaimActions id={c.id} label={label} status={c.status} isClaimant={c.claimantId === actor.userId} approvalId={c.approvalId} totalCents={c.totalCents} lines={c.lines} workspaceId={actor.workspaceId} />
              ) : null}
            </td>
          </tr>
        );
      })}
    </DataTable>
  );

  return (
    <div className="flex flex-col gap-6">
      <FinanceHeader
        title="Expenses"
        description="Claim back what you spent for the company. Someone other than you approves the claim; approved claims post to the books and are reimbursed after a second approval."
        actions={actor.canEdit ? <NewClaimButton workspaceId={actor.workspaceId} /> : null}
      />
      {actor.canEdit ? (
        <Panel title="To review">
          {toReview.length === 0 ? <p className="px-5 py-5 text-md text-muted">Nothing waiting for you.</p> : table(toReview, true)}
        </Panel>
      ) : null}
      <Panel title="Your claims">
        {mine.length === 0 ? (
          <Empty icon={<Wallet size={28} aria-hidden />} title="No claims yet">
            Start one with New claim and attach a photo or PDF of each receipt.
          </Empty>
        ) : (
          table(mine, false)
        )}
      </Panel>
    </div>
  );
}
