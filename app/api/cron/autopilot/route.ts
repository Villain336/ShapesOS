// Marketr — scheduled content-autopilot runs (milestone 18).
// POST /api/cron/autopilot
//
// Auth (either), same pattern as /api/cron/backlinks (milestone 15):
//   1. Signed-in session — runs enabled daily/weekly rules for the user's workspace.
//   2. Cron: Authorization: Bearer <CRON_SECRET> — runs enabled daily/weekly
//      rules across all workspaces. Schedule daily (see DEPLOY.md); the
//      cadence logic inside only runs rules whose cadence is due.
//
// Safety: every rule run goes through runAutopilotRule(), which enforces the
// kill switch, the per-run item cap, idempotency, and the approval gate
// (auto-approve is opt-in per rule, default OFF).

import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cronGate } from "@/lib/cron/gate";
import { isKilledForProject } from "@/lib/seo/autopilot";
import { runAutopilotRule } from "@/lib/seo/autopilot-service";

export const dynamic = "force-dynamic";

/** True when a rule's cadence is due given its lastRunAt. */
function cadenceDue(cadence: string, lastRunAt: Date | null, now: Date): boolean {
  if (!lastRunAt) return true;
  const ms = now.getTime() - lastRunAt.getTime();
  if (cadence === "daily") return ms >= 20 * 60 * 60 * 1000;
  if (cadence === "weekly") return ms >= 6 * 24 * 60 * 60 * 1000;
  return false; // manual rules never run on schedule
}

export async function POST(req: NextRequest) {
  // Day-1 hardening (M1): shared cron gate (lib/cron/gate.ts) — CRON_SECRET
  // service call, or signed-in session with editor+ on the user's workspace.
  const gate = await cronGate(req);
  if (gate instanceof Response) return gate;
  const { isCron, workspaceId: sessionWorkspaceId } = gate;

  const workspaceId = isCron ? null : sessionWorkspaceId!;
  const now = new Date();

  const rules = await prisma.autopilotRule.findMany({
    where: {
      enabled: true,
      cadence: { in: ["daily", "weekly"] },
      ...(workspaceId ? { project: { workspaceId } } : {}),
    },
    include: { project: { select: { id: true, workspaceId: true } } },
  });

  const due = rules.filter((r) => cadenceDue(r.cadence, r.lastRunAt, now));
  const results: { ruleId: string; ok: boolean; generated?: number; error?: string }[] = [];

  for (const rule of due) {
    try {
      const out = await runAutopilotRule(prisma, {
        workspaceId: rule.project.workspaceId,
        projectId: rule.projectId,
        ruleId: rule.id,
        actor: "cron",
      });
      results.push({ ruleId: rule.id, ok: true, generated: out.generated });
    } catch (err) {
      results.push({ ruleId: rule.id, ok: false, error: err instanceof Error ? err.message : "failed" });
    }
  }

  return Response.json({ rules: due.length, results });
}
