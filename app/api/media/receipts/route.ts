// Marketr — GET/POST /api/media/receipts (Phase 5 B1/B2).
//
// Receipt capture closes the loop on concierge execution: the sandboxed
// browser-agent executor (or a human working from a launch packet)
// records the operator's invoice/receipt here. Parsed terms are
// re-verified against the approved binding at capture time — spend at or
// under the approved maximum records verified=true; an over-cap or
// mismatched invoice is still recorded honestly (verified=false,
// flagged) so the discrepancy is auditable instead of hidden.
// GET: viewer+. POST: editor+.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { createHash } from "node:crypto";
import { mediaGuard, badRequest } from "../_lib";
import { SqlMediaReceiptStore, appendBuyingEvent, buyingTablesReady } from "@/lib/media/buying-store";
import { SqlApprovalStore } from "@/lib/media/db";
import { verifyReceiptTermsAgainstBinding } from "@/lib/media/receipts";

export const dynamic = "force-dynamic";

const ParsedTermsSchema = z.object({
  vendor: z.string().min(1),
  totalSpendCents: z.number().int().min(0),
  currency: z.string().length(3).optional(),
  flightStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  flightEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  lines: z.array(z.object({ label: z.string(), amountCents: z.number().int().min(0) })).optional(),
  invoiceNumber: z.string().max(100).optional(),
});

const CreateReceiptSchema = z.object({
  buyId: z.string().min(1),
  approvalId: z.string().min(1),
  capturedBy: z.enum(["browser_executor", "human_upload"]),
  parsedTerms: ParsedTermsSchema,
  receiptUrl: z.string().max(2000).optional(),
});

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated.", receipts: [] }, { status: 503 });
  }
  const buyId = req.nextUrl.searchParams.get("buyId");
  if (!buyId) return badRequest("buyId is required");
  const store = new SqlMediaReceiptStore();
  return Response.json({ receipts: await store.listForBuy(buyId, gate.workspaceId) });
}

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await buyingTablesReady())) {
    return Response.json({ error: "Phase 5 buying tables are not yet migrated." }, { status: 503 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreateReceiptSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const body = parsed.data;
  const terms = body.parsedTerms;

  // Re-verify parsed terms against the approved binding at capture time.
  // An over-cap invoice is recorded honestly (verified=false) — it must
  // not silently pass as verified.
  let verified = false;
  let flags: string[] = [];
  try {
    const approvals = new SqlApprovalStore();
    const approval = await approvals.get(body.approvalId, gate.workspaceId);
    if (!approval) return badRequest("Approval not found in this workspace");
    ({ verified, flags } = verifyReceiptTermsAgainstBinding(terms, approval.binding));
  } catch (e) {
    flags.push(`Binding verification unavailable: ${e instanceof Error ? e.message : "unknown error"}`);
  }

  const store = new SqlMediaReceiptStore();
  const receipt = await store.create({
    workspaceId: gate.workspaceId,
    buyId: body.buyId,
    capturedBy: body.capturedBy,
    platformInvoiceRef: terms.invoiceNumber ?? null,
    amountCents: terms.totalSpendCents,
    currency: terms.currency ?? "USD",
    receiptUrl: body.receiptUrl ?? null,
    parsedTermsJson: { ...(terms as unknown as Record<string, unknown>), flags },
    verified,
    // approvalRef is NOT NULL on the merged media_receipts table
    // (zero-custody invariant: every receipt traces to an approval).
    approvalRef: body.approvalId,
  });

  const payloadHash = createHash("sha256")
    .update(JSON.stringify({ buyId: body.buyId, approvalId: body.approvalId, terms, verified }))
    .digest("hex");
  await appendBuyingEvent({
    workspaceId: gate.workspaceId,
    actor: gate.userId,
    action: verified ? "receipt.recorded" : "receipt.flagged",
    entityType: "receipt",
    entityId: receipt.id,
    payloadHash,
    detail: { buyId: body.buyId, approvalId: body.approvalId, capturedBy: body.capturedBy, verified, flags },
  });

  return Response.json({ receipt, verified, flags }, { status: 201 });
}
