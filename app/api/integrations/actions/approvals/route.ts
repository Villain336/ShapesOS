// Marketr — Phase 14: approvals queue API.
// GET  /api/integrations/actions/approvals[?status=]
// POST /api/integrations/actions/approvals { appKey, toolName, args }

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { listApprovals, proposeAction } from "@/lib/integrations/actions/gate";

export const dynamic = "force-dynamic";

const ProposeSchema = z.object({
  appKey: z.string().trim().min(1).max(64),
  toolName: z.string().trim().min(1).max(128),
  args: z.record(z.string(), z.unknown()).default({}),
});

const STATUS = ["pending", "approved", "denied", "expired", "all"] as const;

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const status = new URL(req.url).searchParams.get("status");
    const parsed = STATUS.includes(status as (typeof STATUS)[number])
      ? (status as (typeof STATUS)[number])
      : "all";
    const approvals = await listApprovals(workspace.id, { status: parsed });
    return Response.json({ approvals });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = ProposeSchema.parse(await readJson(req));
    const { approval, classified } = await proposeAction({
      workspaceId: workspace.id,
      appKey: body.appKey,
      toolName: body.toolName,
      args: body.args as Record<string, unknown>,
      proposedBy: user.id,
    });
    return Response.json({ approval, tier: classified.tier, autoExecutable: classified.autoExecutable });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
