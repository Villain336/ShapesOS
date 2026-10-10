// ShapesOS — Phase 21A (WS=agentweb): search and answer settings.
// GET /api/answer/settings → { config, providers: [{ id, label, configured, mock }] }   (any member)
// PUT /api/answer/settings { providerOrder?, captureRetentionDays?, answerCapCredits? }   (admin+)

import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireWorkspaceRole } from "@/lib/authz";
import { ForbiddenError } from "@/lib/api/errors";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { getConfig, saveConfig, SettingsError } from "@/lib/agentweb/settings";
import { KNOWN_PROVIDERS } from "@/lib/answer/providers";
import { providerStatus } from "@/lib/answer/providers/status";

export const dynamic = "force-dynamic";

const Body = z.object({
  providerOrder: z.array(z.string().max(20)).max(5).optional(),
  captureRetentionDays: z.number().int().optional(),
  answerCapCredits: z.number().int().optional(),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    return Response.json({ config: await getConfig(workspace.id), providers: providerStatus() }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const { user, workspace } = await guardWorkspace();
    if (!(await requireWorkspaceRole(user.id, workspace.id, "admin"))) throw new ForbiddenError("Only an admin can change these settings.");
    const body = Body.parse(await readJson(req));
    return Response.json({ config: await saveConfig(workspace.id, body, KNOWN_PROVIDERS) });
  } catch (e) {
    if (e instanceof SettingsError) return Response.json({ error: e.message }, { status: 400 });
    return httpErrorResponse(e);
  }
}
