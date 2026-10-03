// Marketr — Phase 13D: voice agents API.
// GET  /api/voice/agents → list agents
// POST /api/voice/agents { name, purpose?, voiceId, voiceBackend?, config? } → create
//
// Workspace resolves from the session (guardWorkspace), matching the
// Worker-B voice routes. Editor role required for mutations.

import type { NextRequest } from "next/server";
import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import { listAgents, createAgent } from "@/lib/voice/agents";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const agents = await listAgents(workspace.id);
    return Response.json({ agents });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const agent = await createAgent(workspace.id, {
      name: String(body.name ?? ""),
      purpose: body.purpose as "followup" | "voiceover" | undefined,
      voiceId: String(body.voiceId ?? ""),
      voiceBackend: body.voiceBackend as "voicestudio" | "byo_provider" | undefined,
      config: (body.config ?? {}) as never,
    });
    return Response.json({ agent }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
