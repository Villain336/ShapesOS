// Marketr — /api/media/reconciliation.
// GET ?buyId=: ledger vs platform actuals/invoices — variance surfaced, never silent.
// POST: record a ledger spend entry or a receipt.
//   { kind: "spend-entry", buyId, spendKind, amountCents, approvalRef, note? }
//   { kind: "receipt", buyId, platformInvoiceRef, amountCents, approvalRef }
// approvalRef is MANDATORY (zero-custody invariant) — missing → 400.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest } from "../_lib";
import { getMediaStore } from "@/lib/media/store";
import {
  FakePlatformSpendFeed,
  reconcileBuy,
  recordSpend,
  recordReceipt,
  type PlatformSpendLine,
} from "@/lib/media/reconciliation";

export const dynamic = "force-dynamic";

const SpendEntrySchema = z.object({
  kind: z.literal("spend-entry"),
  buyId: z.string().trim().min(1).max(64),
  spendKind: z.enum(["estimate", "encumbrance", "spend", "release", "adjust"]),
  amountCents: z.number().int().min(0),
  approvalRef: z.string().trim().min(1),
  note: z.string().trim().max(500).optional(),
});

const ReceiptSchema = z.object({
  kind: z.literal("receipt"),
  buyId: z.string().trim().min(1).max(64),
  platformInvoiceRef: z.string().trim().min(1).max(128),
  amountCents: z.number().int().min(0),
  approvalRef: z.string().trim().min(1),
});

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  const buyId = req.nextUrl.searchParams.get("buyId");
  if (!buyId) return badRequest("buyId is required");

  // Fake platform-spend feed default. In production the feed is seeded from
  // operator invoice pulls; variance is always surfaced, never silent.
  const feed = new FakePlatformSpendFeed();
  const seeded = req.nextUrl.searchParams.get("seedActuals");
  if (seeded) {
    try {
      feed.seed(JSON.parse(seeded) as PlatformSpendLine[]);
    } catch {
      return badRequest("seedActuals must be JSON PlatformSpendLine[]");
    }
  }
  const report = await reconcileBuy(getMediaStore(), feed, gate.workspaceId, buyId);
  return Response.json({ report });
}

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = z.union([SpendEntrySchema, ReceiptSchema]).safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const store = getMediaStore();
    if (parsed.data.kind === "spend-entry") {
      const entry = await recordSpend(store, {
        workspaceId: gate.workspaceId,
        buyId: parsed.data.buyId,
        kind: parsed.data.spendKind,
        amountCents: parsed.data.amountCents,
        approvalRef: parsed.data.approvalRef,
        note: parsed.data.note,
      });
      return Response.json({ entry });
    }
    const receipt = await recordReceipt(store, {
      workspaceId: gate.workspaceId,
      buyId: parsed.data.buyId,
      platformInvoiceRef: parsed.data.platformInvoiceRef,
      amountCents: parsed.data.amountCents,
      approvalRef: parsed.data.approvalRef,
    });
    return Response.json({ receipt });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Write failed";
    const status = msg.includes("approvalRef") ? 400 : 400;
    return Response.json({ error: msg }, { status });
  }
}
