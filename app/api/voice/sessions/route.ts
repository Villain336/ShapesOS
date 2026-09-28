// Marketr — Phase 13D: call sessions API.
// GET  /api/voice/sessions?agentId=&status=&leadId= → list
// POST /api/voice/sessions { agentId, leadId, scriptId, channel, requestLive?, approvedBy? }
//      → runs requestSession(): all four gates enforced in one function.
//      Refusals are persisted as blocked sessions with blockReason (never silent).
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
import { listSessions, requestSession } from "@/lib/voice/sessions";

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
    const sessions = await listSessions(workspace.id, {
      agentId: q.get("agentId") ?? undefined,
      status: q.get("status") ?? undefined,
      leadId: q.get("leadId") ?? undefined,
    });
    return Response.json({ sessions });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: NextRequest) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as Record<string, unknown>;
    const channel = String(body.channel ?? "");
    if (!["voice", "sms", "chat"].includes(channel))
      return httpErrorResponse(new HttpError(400, "channel must be voice, sms, or chat"));
    if (!body.agentId || !body.leadId || !body.scriptId)
      return httpErrorResponse(
        new HttpError(400, "agentId, leadId, and scriptId are required"),
      );
    try {
      const result = await requestSession(
        workspace.id,
        {
          agentId: String(body.agentId),
          leadId: String(body.leadId),
          scriptId: String(body.scriptId),
          channel: channel as "voice" | "sms" | "chat",
          requestLive: body.requestLive === true,
          approvedBy: body.approvedBy ? String(body.approvedBy) : undefined,
        },
        { actorUserId: user.id },
      );
      return Response.json(
        {
          session: result.session,
          blocked: result.blocked,
          blockReason: result.blockReason ?? null,
          consent: result.consent,
        },
        { status: result.blocked ? 200 : 201 },
      );
    } catch (e) {
      return asResponse(e, "Session request failed");
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
