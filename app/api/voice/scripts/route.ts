// Marketr — Phase 13D: call scripts API.
// GET  /api/voice/scripts?agentId=&status= → list (with disclosure check result)
// POST /api/voice/scripts { agentId, name, body } → create draft
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
import { listScripts, createDraftScript, type ScriptBody } from "@/lib/voice/scripts";

export const dynamic = "force-dynamic";

// Plain validation Errors from the lib layer surface as 400; HttpErrors keep
// their own status via httpErrorResponse.
function asResponse(e: unknown, fallback: string) {
  if (e instanceof HttpError) return httpErrorResponse(e);
  return Response.json(
    { error: e instanceof Error ? e.message : fallback },
    { status: 400 },
  );
}

export async function GET(req: NextRequest) {
  try {
    const { workspace } = await guardWorkspace();
    const q = req.nextUrl.searchParams;
    const scripts = await listScripts(workspace.id, {
      agentId: q.get("agentId") ?? undefined,
      status: q.get("status") ?? undefined,
    });
    return Response.json({ scripts });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    if (!body.agentId)
      return httpErrorResponse(new HttpError(400, "agentId is required"));
    try {
      const script = await createDraftScript(workspace.id, {
        agentId: String(body.agentId),
        name: String(body.name ?? ""),
        body: (body.body ?? {}) as ScriptBody,
      });
      return Response.json({ script }, { status: 201 });
    } catch (e) {
      return asResponse(e, "Failed to create script");
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
