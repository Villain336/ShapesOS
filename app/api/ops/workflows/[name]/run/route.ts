// Marketr — Phase 17 slice 6: POST /api/ops/workflows/[name]/run.
//
// The pre-authorized workflow pattern in two calls:
//   1. POST { inputs, runKey }            → 202 { approval_required: true,
//      approval, plan, rollbackPlan, summary } — the approver reviews EVERY
//      step AND every compensation before anything runs.
//   2. POST { inputs, runKey, approvalId } → 201 { run } — the runner
//      verifies the approval once (fail-closed: approved, unexpired,
//      binding matches the exact plan) and executes steps + compensations
//      under it. runKey is the replay lock (409 on repeat).
//
// Editor role required (money-moving). Unknown workflow → 404.

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  OpsError,
  OpsGateError,
  type OpsActor,
} from "@/lib/ops/doctype";
import {
  proposeWorkflowRun,
  runWorkflow,
  workflowDef,
} from "@/lib/ops/workflows";

export const dynamic = "force-dynamic";

async function opsGuard(): Promise<OpsActor | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  return { userId: user.id, workspaceId: workspace.id };
}

function opsError(err: unknown) {
  if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
  // Fail closed: gate bypass attempts are 422, never silent.
  if (err instanceof OpsGateError) {
    return Response.json({ error: err.message, code: err.code }, { status: 422 });
  }
  const message = err instanceof Error ? err.message : String(err);
  return Response.json({ error: message }, { status: 500 });
}

async function readJson(req: NextRequest): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    return text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    return { __invalid: true };
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ name: string }> },
) {
  const gate = await opsGuard();
  if (gate instanceof Response) return gate;
  try {
    const { name } = await params;
    const def = workflowDef(name);
    const body = await readJson(req);
    if (body.__invalid) throw new OpsError(400, "Invalid JSON body");
    const runKey =
      typeof body.runKey === "string" && body.runKey ? body.runKey : crypto.randomUUID();
    const inputs =
      body.inputs && typeof body.inputs === "object"
        ? (body.inputs as Record<string, unknown>)
        : {};
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : undefined;

    if (!approvalId) {
      // Propose: resolve inputs, derive the deterministic plan, return the
      // Phase 14 approval with the full step plan + rollback plan.
      const proposed = await withWorkspaceScope(gate.workspaceId, (tx) =>
        proposeWorkflowRun(tx, gate, def, { runKey, inputs }),
      );
      return Response.json(
        {
          approval_required: true,
          approval: proposed.approval,
          workflow: def.name,
          label: def.label,
          plan: proposed.plan,
          summary: proposed.summary,
          runKey: proposed.runKey,
        },
        { status: 202 },
      );
    }

    // Execute under the pre-authorized approval.
    const { run } = await withWorkspaceScope(gate.workspaceId, (tx) =>
      runWorkflow(tx, gate, def, { runKey, inputs, approvalId }),
    );
    return Response.json({ run }, { status: 201 });
  } catch (err) {
    return opsError(err);
  }
}
