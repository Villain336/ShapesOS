// Marketr — GET /api/messaging/log
//
// OutboundMessage ledger for the workspace, with filters.
// ?channel=sms|email ?status=queued|sent|... ?kind=sequence|... ?leadId=… ?limit=50

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { messagingGuard } from "../_lib";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await messagingGuard("viewer");
  if (gate instanceof Response) return gate;

  const q = req.nextUrl.searchParams;
  const limitQuery = parseQuery(z.object({ limit: intQuery(50, 1, 200) }), q);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;
  const where: Record<string, unknown> = { workspaceId: gate.workspaceId };
  for (const [param, field] of [
    ["channel", "channel"],
    ["status", "status"],
    ["kind", "kind"],
    ["leadId", "leadId"],
  ] as const) {
    const v = q.get(param)?.trim();
    if (v) where[field] = v;
  }

  const messages = await prisma.outboundMessage.findMany({
    where,
    include: { lead: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return Response.json({ messages, workspaceId: gate.workspaceId });
}
