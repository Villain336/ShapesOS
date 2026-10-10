// ShapesOS — Phase 21A round 2 (WS=agentweb): GET /api/agentweb/mandates?status=&runId=
// — this workspace's cart requests (any member may look; deciding is the card's job).

import { NextResponse } from "next/server";
import { httpErrorResponse } from "@/lib/enrichment/guard";
import { answerActor } from "@/lib/answer/http";
import { listMandates, type MandateStatus } from "@/lib/agentweb/commerce/mandate-store";

export const dynamic = "force-dynamic";

const STATUSES = new Set(["pending", "signed", "rejected", "used", "expired"]);

export async function GET(req: Request) {
  try {
    const { workspace } = await answerActor();
    const q = new URL(req.url).searchParams;
    const status = q.get("status");
    const runId = q.get("runId");
    const items = await listMandates(workspace.id, { status: status && STATUSES.has(status) ? (status as MandateStatus) : undefined, runId: runId && /^[A-Za-z0-9_-]{1,64}$/.test(runId) ? runId : undefined });
    return NextResponse.json({ mandates: items }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
