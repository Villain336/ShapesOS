// ShapesOS Phase 10 (ops-core): POST /api/cron/ops-helpdesk-sla
//
// Auth (shared cron gate, lib/cron/gate.ts): CRON_SECRET sweeps every
// workspace; a signed-in editor+ sweeps their own.
//
// Records each open ticket's FIRST missed SLA target once (slaBreachedAt,
// guarded) and notifies the assignee + editors through the existing
// notification producers (lib/notifications/producers.ts) after the scoped
// transaction commits. Breaches are computed from the ticket's due dates
// (lib/ops/helpdesk.ts slaState) — nothing is sent to customers.

import type { NextRequest } from "next/server";
import { cronGate } from "@/lib/cron/gate";
import { allWorkspaceIds, sweepAllSla } from "@/lib/ops/helpdesk";
import { notifyTicketSlaBreached } from "@/lib/notifications/producers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const workspaceIds = gate.isCron ? await allWorkspaceIds() : [gate.workspaceId!];
  const results = await sweepAllSla(workspaceIds, (workspaceId, b) =>
    notifyTicketSlaBreached({ workspaceId, ticketId: b.ticketId, number: b.number, subject: b.subject, kind: b.kind, assigneeId: b.assigneeId }),
  );
  return Response.json({ ok: true, breached: results.reduce((s, r) => s + r.breached, 0), results });
}
