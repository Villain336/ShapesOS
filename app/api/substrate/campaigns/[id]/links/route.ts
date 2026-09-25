// Marketr — Phase 8 G2: link attach/list routes.
// POST /api/substrate/campaigns/:id/links (attach fragment — human or orchestrator)
// GET  /api/substrate/campaigns/:id/links (links with fragment summaries)

import {
  substrateGuard, badRequest, campaignError, campaignTablesReady, tablesNotReady, readJson,
} from "../../../_lib";
import { attachLink, getCampaign } from "@/lib/substrate/campaigns/store";
import { readFragment } from "@/lib/substrate/campaigns/fragments";
import { withCampaignScope } from "@/lib/substrate/campaigns/rls";
import { CAMPAIGN_STAGES, LINKED_TYPES, type CampaignLinkedType, type CampaignLinkRole, type CampaignLinkSource, type CampaignStageKey } from "@/lib/substrate/campaigns/types";
import { auditEvent } from "@/lib/auditlog";

export const dynamic = "force-dynamic";

const ROLES: CampaignLinkRole[] = ["primary", "supporting"];
const SOURCES: CampaignLinkSource[] = ["human", "naming_convention", "utm", "api"];

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  try {
    const campaign = await getCampaign(gate.workspaceId, id);
    const enriched = await withCampaignScope(gate.workspaceId, async (tx) => {
      const out = [];
      for (const link of campaign.links) {
        const f = await readFragment(tx, gate.workspaceId, link.linkedType, link.linkedId);
        out.push({ link, fragment: f });
      }
      return out;
    });
    return Response.json({ links: enriched });
  } catch (err) {
    return campaignError(err);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await substrateGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await campaignTablesReady())) return tablesNotReady();
  const { id } = await ctx.params;
  const body = await readJson(req);

  const linkedType = body.linkedType as CampaignLinkedType;
  if (!LINKED_TYPES.includes(linkedType)) {
    return badRequest(`linkedType must be one of: ${LINKED_TYPES.join(", ")}`);
  }
  const linkedId = body.linkedId as string;
  if (typeof linkedId !== "string" || !linkedId.trim()) return badRequest("linkedId is required");
  const role = (body.role ?? "primary") as CampaignLinkRole;
  if (!ROLES.includes(role)) return badRequest(`role must be one of: ${ROLES.join(", ")}`);
  const linkSource = (body.linkSource ?? "human") as CampaignLinkSource;
  if (!SOURCES.includes(linkSource)) return badRequest(`linkSource must be one of: ${SOURCES.join(", ")}`);
  const stageKey = body.stageKey as CampaignStageKey | undefined;
  if (stageKey !== undefined && !(CAMPAIGN_STAGES as readonly string[]).includes(stageKey)) {
    return badRequest("stageKey must be one of the 12 campaign stages");
  }

  try {
    const { link, budgetRollupCents } = await attachLink(gate.workspaceId, id, {
      linkedType,
      linkedId: linkedId.trim(),
      role,
      linkSource,
      stageKey,
      platformRef: (body.platformRef as Record<string, unknown> | null) ?? null,
      linkedBy: gate.userId,
    });
    await auditEvent({
      projectId: null,
      workspaceId: gate.workspaceId,
      action: "campaign_link_attached",
      summary: `Attached ${linkedType} ${linkedId.trim()} to growth campaign ${id} (role ${role}, source ${linkSource})`,
      actorUserId: gate.userId,
    });
    return Response.json({ link, budgetRollupCents }, { status: 201 });
  } catch (err) {
    return campaignError(err);
  }
}
