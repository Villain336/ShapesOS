// Marketr — Phase 13D: single session API.
// GET   /api/voice/sessions/[id] → detail (transcript + audit trail + consent proof)
// PATCH /api/voice/sessions/[id] { op: transition|outcome|transcript|recording_consent, ... }
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
import {
  getSession,
  transitionSession,
  setOutcome,
  appendTranscriptTurn,
  grantRecordingConsent,
  type SessionStatus,
} from "@/lib/voice/sessions";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const session = await getSession(workspace.id, id);
    if (!session) return httpErrorResponse(new HttpError(404, "Session not found"));
    return Response.json({ session });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

const VALID_TRANSITIONS = ["in_progress", "completed", "cancelled"] as const;

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as Record<string, unknown>;
    const op = String(body.op ?? "");
    try {
      let session;
      if (op === "transition") {
        const to = String(body.to ?? "");
        if (!(VALID_TRANSITIONS as readonly string[]).includes(to))
          return httpErrorResponse(
            new HttpError(400, `to must be one of ${VALID_TRANSITIONS.join(", ")}`),
          );
        session = await transitionSession(workspace.id, id, to as SessionStatus, {
          actorUserId: user.id,
          detail: body.detail ? String(body.detail) : undefined,
        });
      } else if (op === "outcome") {
        if (!body.outcome)
          return httpErrorResponse(new HttpError(400, "outcome is required"));
        session = await setOutcome(workspace.id, id, String(body.outcome), {
          actorUserId: user.id,
        });
      } else if (op === "transcript") {
        if (!body.role || !body.text)
          return httpErrorResponse(new HttpError(400, "role and text are required"));
        const role = String(body.role);
        if (!["agent", "prospect", "system"].includes(role))
          return httpErrorResponse(
            new HttpError(400, "role must be agent, prospect, or system"),
          );
        session = await appendTranscriptTurn(workspace.id, id, {
          role: role as "agent" | "prospect" | "system",
          text: String(body.text),
        });
      } else if (op === "recording_consent") {
        session = await grantRecordingConsent(workspace.id, id, {
          actorUserId: user.id,
        });
      } else {
        return httpErrorResponse(
          new HttpError(400, "op must be transition, outcome, transcript, or recording_consent"),
        );
      }
      return Response.json({ session });
    } catch (e) {
      return httpErrorResponse(e);
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
