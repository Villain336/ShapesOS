// Marketr — usage CSV export (Phase C, W4).
// GET /api/usage/export?workspaceId=&periodStart= → text/csv download.
// The agency chargeback story: Mara bills each client from this ledger.
// Reads: admin+. evidence_ref is labeled unverified (threat model T7).

import { csvCell } from "@/lib/csv";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess, workspaceIdFrom } from "@/lib/route-utils";

export const dynamic = "force-dynamic";


export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;

  const params = req.nextUrl.searchParams;
  const periodStart = params.get("periodStart");
  const since = periodStart ? new Date(periodStart) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  if (Number.isNaN(since.getTime())) {
    return Response.json({ error: "Invalid periodStart" }, { status: 400 });
  }

  const events = await prisma.usageEvent.findMany({
    where: { workspaceId: access.workspaceId, occurredAt: { gte: since } },
    orderBy: { occurredAt: "asc" },
    take: 50000,
  });

  const header = [
    "occurred_at",
    "action",
    "credits",
    "project_id",
    "actor_id",
    "idempotency_key",
    "evidence_ref (unverified pointer)",
  ];
  const lines = [header.join(",")];
  for (const e of events) {
    lines.push(
      [
        csvCell(e.occurredAt.toISOString()),
        csvCell(e.action),
        csvCell(e.credits),
        csvCell(e.projectId),
        csvCell(e.actorId),
        csvCell(e.idempotencyKey),
        csvCell(e.evidenceRef),
      ].join(","),
    );
  }

  const stamp = since.toISOString().slice(0, 10);
  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="marketr-usage-${stamp}.csv"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
