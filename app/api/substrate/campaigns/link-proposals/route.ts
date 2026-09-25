// Marketr — Phase 8 G2: backfill proposal review queue + scan trigger.
// GET  /api/substrate/campaigns/link-proposals (queue; ?status=&campaignId=)
// POST /api/substrate/campaigns/link-proposals (run the proposer scan —
//   writes proposals only, NEVER auto-links)

import type { NextRequest } from "next/server";
import {
  substrateGuard, badRequest, campaignError, campaignTablesReady, tablesNotReady, readJson,
} from "../../_lib";
import { listProposals, proposeBackfillLinks } from "@/lib/substrate/campaigns/store";
import type { LinkProposalStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

const PROP_STATUSES: LinkProposalStatus[] = ["pending", "approved", "rejected"];

export async function GET(req: NextRequest) {
  const gate = await substrateGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  try {
    const proposals = await listProposals(gate.workspaceId, {
      status: status && (PROP_STATUSES as string[]).includes(status) ? (status as LinkProposalStatus) : undefined,
      campaignId: sp.get("campaignId") ?? undefined,
    });
    return Response.json({ proposals });
  } catch (err) {
    return campaignError(err);
  }
}

export async function POST(req: NextRequest) {
  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const body = await readJson(req);
  const campaignId = body.campaignId as string | undefined;
  if (campaignId !== undefined && typeof campaignId !== "string") {
    return badRequest("campaignId must be a string");
  }
  try {
    const result = await proposeBackfillLinks(gate.workspaceId, { campaignId });
    return Response.json({
      ...result,
      note: "Proposals only — links materialize solely via human approval (POST link-proposals/:id/resolve). Zero auto-links.",
    });
  } catch (err) {
    return campaignError(err);
  }
}
