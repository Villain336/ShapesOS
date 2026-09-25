// Marketr — POST /api/media/kill-rules/evaluate
// Sweeper tick: evaluate enabled rules against submitted metrics snapshots.
// Called by the scheduler (5–15 min critical / hourly trend) with
// CRON_SECRET bearer auth, or manually by owners. Every fired action is
// logged tracing back to the human-set rule that fired it.

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../../_lib";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { evaluateRules, logMediaEvent, type MetricsSnapshot } from "@/lib/media/killswitch";

export const dynamic = "force-dynamic";

const SnapshotSchema = z.object({
  poolId: z.string().optional(),
  platform: z.string().optional(),
  buyId: z.string().optional(),
  approvalId: z.string().optional(),
  cpa: z.number().optional(),
  spendCents: z.number().int().min(0),
  dailySpendPct: z.number().min(0).optional(),
  conversions: z.number().int().min(0),
  ctr: z.number().optional(),
  ctrDecayPct: z.number().optional(),
  failures: z.number().int().min(0).optional(),
  hourOfDay: z.number().int().min(0).max(23).optional(),
});

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = z.object({ snapshots: z.array(SnapshotSchema).min(1).max(200) }).safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { approvals, killRules } = mediaStores();
    const snapshots: MetricsSnapshot[] = parsed.data.snapshots.map((s) => ({ ...s, ts: new Date() }));
    const fired = await evaluateRules(killRules, gate.workspaceId, snapshots, {
      now: () => new Date(),
      onAction: async (action) => {
        // Trace every action to the human-set rule (Birch pattern): log to
        // the approval's event log when the snapshot names an approval.
        console.log(
          `[sweeper] rule "${action.ruleName}" (${action.ruleId}) fired → ${action.action} (set by ${action.createdBy})`,
        );
        if (action.snapshot.approvalId) {
          await logMediaEvent(
            approvals,
            action.snapshot.approvalId,
            gate.workspaceId,
            "system",
            "kill_rule_fired",
            {
              ruleId: action.ruleId,
              ruleName: action.ruleName,
              action: action.action,
              ruleSetBy: action.createdBy,
            },
          );
        }
      },
    });
    return Response.json({ fired });
  } catch (err) {
    return safetyError(err);
  }
}
