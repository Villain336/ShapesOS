// Marketr — POST /api/flywheel/recycling/briefs/[id]/approve
// Human approval (editor+): draft → approved → regenerating. Every variant is
// routed into the studio approval flows (review-queue receipts, never
// publishes). SPEC-PHASE7 §9.9: recycling proposes; humans approve.

import type { NextRequest } from "next/server";
import { recyclingGuard, badRequest, notProvisioned, recyclingError } from "../../../_lib";
import { ApproveBriefSchema } from "../../../_schemas";
import {
  recyclingTablesReady, prismaRecyclingBriefStore, prismaRecyclingAuditStore,
} from "@/lib/flywheel/recycling/db";
import { approveBrief, fakeStudioRouter } from "@/lib/flywheel/recycling/briefs";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  const gate = await recyclingGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await recyclingTablesReady())) return notProvisioned();

  let raw: unknown = {};
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = ApproveBriefSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  const { id } = await params;
  try {
    const { brief, receipts } = await approveBrief({
      store: prismaRecyclingBriefStore(),
      audit: prismaRecyclingAuditStore(),
      router: fakeStudioRouter, // v1: fake router — review-queue receipts, never publishes
      id,
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      note: parsed.data.note,
    });
    return Response.json({
      brief,
      receipts,
      note: "Variants routed into the studio approval flows. Nothing was published; nothing entered a buy.",
    });
  } catch (err) {
    return recyclingError(err);
  }
}
