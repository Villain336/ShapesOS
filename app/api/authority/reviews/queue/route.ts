// Marketr — GET /api/authority/reviews/queue
//
// R1 approval queue: positives standard, negatives urgent-first.
// v1 is drafts-only — the queue is the human's inbox; nothing posts itself.

import type { NextRequest } from "next/server";
import { authorityGuard, badRequest, safetyError } from "@/app/api/authority/_lib";
import { listQueue } from "@/lib/authority/reviews/service";
import { authorityTablesReady } from "@/lib/authority/db";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await authorityGuard("viewer");
  if (gate instanceof Response) return gate;

  if (!(await authorityTablesReady().catch(() => false))) {
    return Response.json({ queue: [], tablesReady: false });
  }

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const sentiment = sp.get("sentiment");
  try {
    const allowedStatus = ["pending", "approved", "posted", "rejected", "escalated"];
    const allowedSentiment = ["pos", "neu", "neg"];
    if (status && !allowedStatus.includes(status)) return badRequest("Invalid status filter.");
    if (sentiment && !allowedSentiment.includes(sentiment)) return badRequest("Invalid sentiment filter.");
    const queue = await listQueue(gate.workspaceId, {
      status: (status ?? undefined) as never,
      sentiment: (sentiment ?? undefined) as never,
      limit: 100,
    });
    const urgent = queue.filter((q) => q.sentiment === "neg" && q.status === "pending").length;
    return Response.json({ queue, urgent, tablesReady: true });
  } catch (e) {
    return safetyError(e);
  }
}
