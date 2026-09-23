// Marketr — monthly overage invoicing cron (hosted Stripe track).
// POST /api/cron/overage-invoicing
//
// Auth (either), same pattern as the other /api/cron/* routes:
//   1. Signed-in session (editor+) — invoices the user's workspace only.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — sweeps every workspace
//      with auto-overage opted in. Schedule monthly (see DEPLOY.md):
//      0 3 1 * *
//
// What it does per workspace: invoices accrued overage from COMPLETED UTC
// months (cutoff = start of the current month — never a partial month).
// Amounts come from the UsageEvent ledger (sum of overage_credits); Stripe
// never decides what is owed. Zero-overage months are skipped; months under
// the $5.00 minimum are skipped WITHOUT advancing the invoice watermark, so
// small amounts carry forward and are billed once the minimum is reached.
//
// Idempotency: invoiceOverage() inserts the invoice row first with key
// overageinvoice:<workspaceId>:<YYYY-MM of the completed billing month> —
// re-running the cron for the same month returns the prior result and makes
// no new Stripe calls. A concurrent second run waits for the in-flight
// invoice to settle (replay); a row stuck mid-flight past the stale timeout
// is reclaimed (Stripe calls carry matching idempotency keys, so re-driving
// is safe). Invoicing fails closed without a verified card on file.
// Unconfigured Stripe → 200 with skipped (the cron must not alarm on
// self-hosted deployments).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { StripeBillingSink, isBillingConfigured, type OverageInvoiceResult } from "@/lib/metering/billing";

export const dynamic = "force-dynamic";

interface WorkspaceResult {
  workspaceId: string;
  status?: OverageInvoiceResult["status"];
  overageCredits?: number;
  amountCents?: number;
  stripeInvoiceId?: string | null;
  error?: string;
}

/** Invoice one workspace's accrued overage (exported for the battery). */
export async function invoiceWorkspaceOverage(
  workspaceId: string,
  now = new Date(),
): Promise<OverageInvoiceResult> {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const sink = new StripeBillingSink();
  return sink.invoiceOverage(workspaceId, cutoff);
}

export async function POST(req: NextRequest) {
  // Shared cron gate — CRON_SECRET service call, or signed-in session with
  // editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  if (!isBillingConfigured()) {
    return Response.json({ ok: true, skipped: "billing_not_configured" });
  }

  const caps = await prisma.spendCap.findMany({
    where: {
      autoOverage: true,
      ...(isCron ? {} : { workspaceId: sessionWorkspaceId! }),
    },
    select: { workspaceId: true },
  });

  const cutoff = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const sink = new StripeBillingSink();
  const results: WorkspaceResult[] = [];
  for (const cap of caps) {
    try {
      const r = await sink.invoiceOverage(cap.workspaceId, cutoff);
      results.push({
        workspaceId: cap.workspaceId,
        status: r.status,
        overageCredits: r.overageCredits,
        amountCents: r.amountCents,
        stripeInvoiceId: r.stripeInvoiceId,
      });
    } catch (err) {
      results.push({
        workspaceId: cap.workspaceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({ ok: true, cutoff: cutoff.toISOString(), results });
}
