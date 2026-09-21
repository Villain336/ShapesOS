// Marketr — scheduled report generation (milestone 12).
// POST /api/cron/reports
//
// Auth (either), same pattern as /api/cron/fix-agent (milestone 10):
//   1. Signed-in session — runs due templates in the user's workspace.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs due templates in
//      every workspace. Schedule it alongside the other cron jobs.
//
// A template is "due" when schedule is weekly/monthly and lastRunAt is older
// than the interval (or never ran). Each run is audit-logged as a `system`
// actor via generateReport().

import { requireWorkspaceRole } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { generateReport } from "@/lib/pdf/generate";

export const dynamic = "force-dynamic";

const INTERVAL_MS: Record<string, number> = {
  weekly: 7 * 24 * 60 * 60 * 1000,
  monthly: 30 * 24 * 60 * 60 * 1000,
};

function cronAuthorized(req: NextRequest): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return false;
  const header = req.headers.get("authorization") ?? "";
  return header === `Bearer ${secret}`;
}

export async function POST(req: NextRequest) {
  const isCron = cronAuthorized(req);
  const user = isCron ? null : await requireUser();
  if (!isCron && !user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const templates = await prisma.reportTemplate.findMany({
    where: {
      schedule: { in: ["weekly", "monthly"] },
      ...(isCron
        ? {}
        : { workspaceId: (await getOrCreateWorkspace(user!.id, user!.email)).id }),
    },
    select: { id: true, name: true, schedule: true, lastRunAt: true, workspaceId: true },
  });

  const now = Date.now();
  const due = templates.filter((t) => {
    const interval = INTERVAL_MS[t.schedule];
    if (!interval) return false;
    if (!t.lastRunAt) return true;
    return now - t.lastRunAt.getTime() >= interval;
  });

  // Milestone 11: session-triggered runs honor RBAC (viewers can't generate).
  // CRON_SECRET path is a service actor and bypasses user roles.
  const results: Array<{ templateId: string; reportId?: string; error?: string }> = [];
  for (const t of due) {
    if (!isCron && user && !(await requireWorkspaceRole(user.id, t.workspaceId, "editor"))) {
      results.push({ templateId: t.id, error: "insufficient role" });
      continue;
    }
    try {
      const report = await generateReport({
        templateId: t.id,
        actor: isCron ? "system" : "user",
        actorId: user?.id ?? null,
      });
      // Milestone 11 audit pattern: the scheduling decision is its own event;
      // generateReport() logs report_generated for the PDF itself.
      await prisma.fileChangeLog.create({
        data: {
          workspaceId: t.workspaceId,
          projectId: null,
          connectionId: null,
          filePath: `report-template:${t.id}`,
          actor: isCron ? "system" : "user",
          action: "report_scheduled",
          summary: `Scheduled ${t.schedule} report "${t.name}" generated`.slice(0, 280),
          approvedBy: user?.id ?? null,
        },
      });
      results.push({ templateId: t.id, reportId: report.id });
    } catch (err) {
      results.push({
        templateId: t.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return Response.json({ due: due.length, results });
}
