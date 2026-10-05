// Marketr — Phase 13D: single voice agent API.
// GET    /api/voice/agents/[id] → detail
// PATCH  /api/voice/agents/[id] { name?, voiceId?, voiceBackend?, status?, config? } → update
// DELETE /api/voice/agents/[id] → delete (refused if sessions exist)
//
// Workspace resolves from the session (guardWorkspace), matching the
// Worker-B voice routes. Editor role required for mutations.

import type { NextRequest } from "next/server";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
  HttpError,
} from "@/lib/enrichment/guard";
import { getAgent, updateAgent, deleteAgent } from "@/lib/voice/agents";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const agent = await getAgent(workspace.id, id);
    if (!agent) return httpErrorResponse(new HttpError(404, "Voice agent not found"));
    return Response.json({ agent });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as Record<string, unknown>;
    const agent = await updateAgent(workspace.id, id, {
      name: body.name !== undefined ? String(body.name) : undefined,
      voiceId: body.voiceId !== undefined ? String(body.voiceId) : undefined,
      voiceBackend:
        body.voiceBackend !== undefined
          ? (body.voiceBackend as "voicestudio" | "byo_provider")
          : undefined,
      status: body.status !== undefined ? String(body.status) : undefined,
      config: body.config !== undefined ? (body.config as never) : undefined,
    });
    return Response.json({ agent });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: NextRequest, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    await deleteAgent(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
