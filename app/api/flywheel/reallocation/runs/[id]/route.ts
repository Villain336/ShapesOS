// Marketr — GET /api/flywheel/reallocation/runs/:id
// Run summary with its proposals.

import type { NextRequest } from "next/server";
import {
  flywheelGuard, safetyError,
  getStore, reallocationTablesReady, tablesNotReady,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await flywheelGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await reallocationTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  try {
    const store = getStore();
    const run = await store.getRun(id, gate.workspaceId);
    if (!run) return Response.json({ error: "Run not found in workspace" }, { status: 404 });
    const proposals = await store.listProposals(gate.workspaceId, 200);
    const runProposals = proposals.filter((p) =>
      Math.abs(+new Date(p.createdAt) - +new Date(run.runAt)) < 60_000,
    );
    return Response.json({ run, proposals: runProposals });
  } catch (err) {
    return safetyError(err);
  }
}
