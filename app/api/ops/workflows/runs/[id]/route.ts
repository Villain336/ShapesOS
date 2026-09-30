// Marketr — Phase 17 slice 6: GET /api/ops/workflows/runs/[id].
//
// Read a workflow run's step timeline + compensation log. Viewer+,
// workspace-scoped by construction (RLS set_config inside withWorkspaceScope).

import type { NextRequest } from "next/server";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { OpsError } from "@/lib/ops/doctype";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const { id } = await params;
  const run = await withWorkspaceScope(workspace.id, (tx) =>
    (tx as unknown as {
      opsWorkflowRun: { findFirst(a: unknown): Promise<Record<string, unknown> | null> };
    }).opsWorkflowRun.findFirst({ where: { id, workspaceId: workspace.id } }),
  );
  if (!run) return Response.json({ error: "Workflow run not found" }, { status: 404 });
  return Response.json({ run });
}
