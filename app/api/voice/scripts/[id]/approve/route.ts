// Marketr — Phase 13D: script review actions (the legal-review surface).
// POST /api/voice/scripts/[id]/approve { action: submit|approve|reject, reason? }
// Editor+. Approve stamps approvedBy/approvedAt (human review). Note: approval
// warns but does not enforce disclosure — the session gate re-validates at
// attach time, so an undiscLOSED approved script still cannot dial.
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
import {
  getScript,
  submitForReview,
  approveScript,
  rejectScript,
  disclosureWarning,
} from "@/lib/voice/scripts";

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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const script = await getScript(workspace.id, id);
    if (!script) return httpErrorResponse(new HttpError(404, "Script not found"));
    return Response.json({
      script,
      disclosureWarning: disclosureWarning({
        opening: String((script.body as { opening?: unknown })?.opening ?? ""),
      }),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace, user } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as { action?: string; reason?: string };
    const action = String(body.action ?? "").trim();
    try {
      let script;
      if (action === "submit") script = await submitForReview(workspace.id, id);
      else if (action === "approve")
        script = await approveScript(workspace.id, id, user.id);
      else if (action === "reject")
        script = await rejectScript(workspace.id, id, body.reason);
      else
        return httpErrorResponse(
          new HttpError(400, "action must be submit, approve, or reject"),
        );
      return Response.json({ script });
    } catch (e) {
      return asResponse(e, "Review action failed");
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
