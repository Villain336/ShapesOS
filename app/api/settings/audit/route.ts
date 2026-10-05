// Marketr — audit log review (milestone 21, spec §5 flow 7).
// GET /api/settings/audit?workspaceId=&actor=&action=&projectId=&from=&to=
//   → { events: [{ id, action, actor, summary, projectId, createdAt }] }
//   newest first, limit 200. (admin+)
// &format=csv → text/csv attachment download.

import { csvCell as sharedCsvCell } from "@/lib/csv";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess } from "@/lib/route-utils";
import type { Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

// Always-quoted, formula-neutralized (shared helper, lib/csv.ts).
const csvCell = (v: string | null) => sharedCsvCell(v, { alwaysQuote: true });

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;

  const q = req.nextUrl.searchParams;
  const where: Prisma.FileChangeLogWhereInput = { workspaceId: access.workspaceId };
  const actor = q.get("actor")?.trim();
  const action = q.get("action")?.trim();
  const projectId = q.get("projectId")?.trim();
  const from = q.get("from")?.trim();
  const to = q.get("to")?.trim();
  if (actor) where.actor = actor as never;
  if (action) where.action = action as never;
  if (projectId) where.projectId = projectId;
  if (from || to) {
    where.createdAt = {};
    if (from) {
      const d = new Date(from);
      if (!Number.isNaN(d.getTime())) where.createdAt.gte = d;
    }
    if (to) {
      const d = new Date(to);
      if (!Number.isNaN(d.getTime())) where.createdAt.lte = d;
    }
  }

  const events = await prisma.fileChangeLog.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { id: true, action: true, actor: true, summary: true, projectId: true, createdAt: true },
  });
  const rows = events.map((e) => ({
    id: e.id,
    action: e.action,
    actor: e.actor,
    summary: e.summary,
    projectId: e.projectId,
    createdAt: e.createdAt.toISOString(),
  }));

  if (q.get("format") === "csv") {
    const lines = [
      "id,createdAt,action,actor,projectId,summary",
      ...rows.map((r) =>
        [csvCell(r.id), csvCell(r.createdAt), csvCell(r.action), csvCell(r.actor), csvCell(r.projectId), csvCell(r.summary)].join(","),
      ),
    ];
    return new Response(lines.join("\n"), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="audit-${access.workspaceId}.csv"`,
      },
    });
  }
  return Response.json({ events: rows });
}
