// ShapesOS — Phase 14 (connectors): what a payroll provider (Gusto) means for
// a pay run's own lifecycle (lib/ops/payroll/runs.ts). No network here — the
// provider calls live in lib/bizsync/gusto/payroll.ts.
//
//   sent    (hours are in Gusto's open payroll, Gusto hasn't processed it)
//           → approving or posting is refused: the figures to approve are
//             the ones Gusto computes (taxes, net), so "Sync results" first.
//             Recomputing is allowed (the send then reads "out of date" and
//             can be sent again; the send is idempotent per compute digest).
//   synced  → the payslips hold Gusto's figures: recomputing is refused (it
//             would replace what Gusto actually paid).
//   paid    → once the run is posted, Net pay payable is cleared by one
//             balanced payment entry (idempotent; journal sourceKey
//             pay_run:<id>:net_pay_paid).

import type { Prisma } from "@prisma/client";
import { OpsError, type OpsActor } from "../doctype";
import { postPayRunNetPayPaid } from "../finance/posting";

type Tx = Prisma.TransactionClient;

export const PAYROLL_PROVIDER_LABEL: Record<string, string> = { gusto: "Gusto" };

export type ProviderSyncRow = Awaited<ReturnType<typeof providerSyncFor>>;

export async function providerSyncFor(tx: Tx, workspaceId: string, payRunId: string) {
  return tx.opsPayRunProviderSync.findFirst({ where: { workspaceId, payRunId } });
}

/** Throws a 409 when the provider state forbids this lifecycle step. */
export function assertProviderAllows(sync: { status: string; provider: string } | null, step: "compute" | "approve" | "post"): void {
  if (!sync) return;
  const label = PAYROLL_PROVIDER_LABEL[sync.provider] ?? sync.provider;
  if (sync.status === "sent" && (step === "approve" || step === "post")) {
    throw new OpsError(409, `This run was sent to ${label}. Review and submit the payroll in ${label}, then use "Sync results" — the run is approved and posted with ${label}'s figures.`);
  }
  if ((sync.status === "synced" || sync.status === "paid") && step === "compute") {
    throw new OpsError(409, `The payslips hold the taxes and net pay ${label} computed and paid — recomputing would replace them. Cancel the run instead if it is wrong.`);
  }
}

/**
 * Clear Net pay payable for a POSTED run the provider has paid. Idempotent
 * (the journal's sourceKey); records the entry on the provider row once.
 */
export async function clearNetPayIfPaid(
  tx: Tx,
  actor: OpsActor,
  run: { id: string; number: string | null; netCents: number; status: string },
  sync: { id: string; provider: string; status: string; paidAt: Date | null; remoteCheckDate: Date | null; paymentEntryId: string | null } | null,
): Promise<string | null> {
  if (!sync || sync.status !== "paid" || run.status !== "posted") return sync?.paymentEntryId ?? null;
  if (sync.paymentEntryId) return sync.paymentEntryId;
  const label = PAYROLL_PROVIDER_LABEL[sync.provider] ?? sync.provider;
  const posted = await postPayRunNetPayPaid(tx, actor, run, sync.remoteCheckDate ?? sync.paidAt ?? new Date(), label);
  if (!posted) return null;
  await tx.opsPayRunProviderSync.updateMany({ where: { id: sync.id, workspaceId: actor.workspaceId, paymentEntryId: null }, data: { paymentEntryId: posted.entry.id } });
  if (posted.created) {
    await tx.opsAuditEvent.create({
      data: { workspaceId: actor.workspaceId, entity: "pay-runs", entityId: run.id, action: "net_pay_paid", actor: actor.userId, summary: `${run.number ?? run.id}: ${label} paid net pay — Net pay payable cleared (journal entry ${posted.entry.id})`.slice(0, 2000) },
    });
  }
  return posted.entry.id;
}
