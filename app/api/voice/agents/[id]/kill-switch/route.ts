// Marketr — Phase 13D: kill-switch endpoint.
// POST /api/voice/agents/[id]/kill-switch { enabled }
// Editor+. When enabled, the agent refuses ALL new sessions immediately.
//
// Workspace resolves from the session (guardWorkspace), matching the
// Worker-B voice routes.

import type { NextRequest } from "next/server";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
  HttpError,
} from "@/lib/enrichment/guard";
import { setKillSwitch } from "@/lib/voice/agents";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean")
      return httpErrorResponse(new HttpError(400, "enabled must be a boolean"));
    const agent = await setKillSwitch(workspace.id, id, body.enabled, user.id);
    return Response.json({ agent });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
