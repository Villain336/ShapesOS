// Marketr — Phase 8 G2: roll-up report route.
// GET /api/substrate/campaigns/:id/report — linked-fragment metrics with
// per-fragment provenance labels. Totals carry explicit semantics notes;
// semantically-different metrics are never silently summed.

import type { NextRequest } from "next/server";
import {
  substrateGuard, campaignError, campaignTablesReady, tablesNotReady,
} from "../../../_lib";
import { campaignReport } from "@/lib/substrate/campaigns/store";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  try {
    const report = await campaignReport(gate.workspaceId, id);
    return Response.json({ report });
  } catch (err) {
    return campaignError(err);
  }
}
