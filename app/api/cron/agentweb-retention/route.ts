// ShapesOS — Phase 21A round 2 (WS=agentweb): retention sweep for stored web pages.
// POST /api/cron/agentweb-retention
//
// Auth (shared cron gate, lib/cron/gate.ts): CRON_SECRET for every workspace, or a signed-in
// editor+ for their own workspace. Removes expired captures (receipts and their stored page text)
// and expired browsing-memory items. Both also expire lazily on write; this makes sure a quiet
// workspace's pages do not outlive their retention. Scheduled daily by the in-app cron runner.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { prisma } from "@/lib/prisma";
import { errorResponse } from "@/lib/api/errors";
import { purgeExpiredCaptures } from "@/lib/agentweb/captures-store";
import { purgeExpiredMemory } from "@/lib/agentweb/memory/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  try {
    const ids = gate.isCron ? (await prisma.workspace.findMany({ select: { id: true }, take: 5000 })).map((w) => w.id) : [gate.workspaceId!];
    let captures = 0;
    let memory = 0;
    for (const id of ids) {
      captures += await purgeExpiredCaptures(id, new Date(), 200).catch(() => 0);
      memory += await purgeExpiredMemory(id).catch(() => 0);
    }
    return Response.json({ workspaces: ids.length, captures, memory });
  } catch (err) {
    return errorResponse(err, "POST /api/cron/agentweb-retention", req);
  }
}
