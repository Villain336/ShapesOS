// Marketr — GET /api/flywheel/reallocation/proposals/:id
// Proposal with its full decision record + policy decision history.

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
    const proposal = await store.getProposal(id, gate.workspaceId);
    if (!proposal) return Response.json({ error: "Proposal not found in workspace" }, { status: 404 });
    const decisions = await store.listPolicyDecisions(id, gate.workspaceId);
    return Response.json({ proposal, policyDecisions: decisions });
  } catch (err) {
    return safetyError(err);
  }
}
