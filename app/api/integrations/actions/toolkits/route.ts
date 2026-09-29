// Marketr — Phase 15 slice 3: toolkit directory API.
// GET  /api/integrations/actions/toolkits — full directory for this workspace
//        (slug, label, category, connected, enabled, tool counts + tier
//        breakdowns — sourced from discovery fixtures + ComposioToolCatalog
//        + WorkspaceToolkit). No packs (locked).
// POST /api/integrations/actions/toolkits — { toolkitSlug, enabled } records
//        the workspace's explicit enable/disable decision (editor role).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import {
  listDirectory,
  setToolkitEnabled,
} from "@/lib/integrations/actions/toolkits";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  toolkitSlug: z.string().trim().min(1).max(64),
  enabled: z.boolean(),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const toolkits = await listDirectory(workspace.id);
    return Response.json({ toolkits });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = BodySchema.parse(await readJson(req));
    const result = await setToolkitEnabled({
      workspaceId: workspace.id,
      toolkitSlug: body.toolkitSlug,
      enabled: body.enabled,
      userId: user.id,
    });
    return Response.json(result);
  } catch (e) {
    return httpErrorResponse(e);
  }
}
