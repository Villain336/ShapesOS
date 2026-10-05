// Marketr — alert event history API (milestone 13).
// GET /api/alerts?ruleId=&status=&take=  → { events } (newest first)
// Reads: any workspace member.

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import type { AlertEventStatus } from "@prisma/client";
import { triggerDef } from "@/lib/alerts/triggers";
import { intQuery, parseQuery, z } from "@/lib/api/validate";

const STATUSES: AlertEventStatus[] = ["queued", "sent", "failed", "suppressed"];

function serialize(event: {
  id: string;
  ruleId: string;
  trigger: string;
  title: string;
  body: string;
  link: string | null;
  dedupKey: string | null;
  queueReason: string | null;
  status: AlertEventStatus;
  results: unknown;
  retryCount: number;
  createdAt: Date;
  sentAt: Date | null;
  rule: { id: string; name: string };
}) {
  return {
    id: event.id,
    ruleId: event.ruleId,
    ruleName: event.rule.name,
    trigger: event.trigger,
    triggerLabel: triggerDef(event.trigger)?.label ?? event.trigger,
    title: event.title,
    body: event.body,
    link: event.link,
    dedupKey: event.dedupKey,
    queueReason: event.queueReason,
    status: event.status,
    results: event.results ?? [],
    retryCount: event.retryCount,
    createdAt: event.createdAt.toISOString(),
    sentAt: event.sentAt?.toISOString() ?? null,
  };
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const url = new URL(req.url);
  const ruleId = url.searchParams.get("ruleId")?.trim() || undefined;
  const status = url.searchParams.get("status")?.trim() as AlertEventStatus | undefined;
  const takeQuery = parseQuery(z.object({ take: intQuery(50, 1, 200) }), url.searchParams);
  if (!takeQuery.ok) return takeQuery.error;
  const take = takeQuery.data.take;

  if (ruleId) {
    const rule = await prisma.alertRule.findFirst({ where: { id: ruleId, workspaceId: workspace.id }, select: { id: true } });
    if (!rule) return Response.json({ error: "Rule not found" }, { status: 404 });
  }

  const events = await prisma.alertEvent.findMany({
    where: {
      workspaceId: workspace.id,
      ...(ruleId ? { ruleId } : {}),
      ...(status && STATUSES.includes(status) ? { status } : {}),
    },
    orderBy: { createdAt: "desc" },
    take,
    include: { rule: { select: { id: true, name: true } } },
  });

  return Response.json({ events: events.map(serialize) });
}
