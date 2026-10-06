// ShapesOS — Phase 18.2 (WS=comms): a person decides a merge suggestion.
//   POST /api/comms/contacts/suggestions/[id] { decision: "confirm" | "reject" } → { identityId? }   (editor+)
// Confirm merges the two contacts (the only way they ever merge); reject is
// remembered for the record pair. Audited.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { confirmSuggestion, rejectSuggestion } from "@/lib/comms/contacts/store";
import { auditEvent } from "@/lib/auditlog";
import { commsGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ decision: z.enum(["confirm", "reject"]) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await commsGuard("editor");
    const { id } = await params;
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const suggestionId = String(id).slice(0, 64);
    if (parsed.data.decision === "confirm") {
      const out = await withWorkspaceScope(ctx.workspaceId, (tx) => confirmSuggestion(tx, { workspaceId: ctx.workspaceId, suggestionId, userId: ctx.userId }));
      await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "contact_merge_confirmed", summary: `Merged contacts (suggestion ${suggestionId})` }).catch(() => undefined);
      return Response.json(out);
    }
    await withWorkspaceScope(ctx.workspaceId, (tx) => rejectSuggestion(tx, { workspaceId: ctx.workspaceId, suggestionId, userId: ctx.userId }));
    await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "contact_merge_rejected", summary: `Not the same person (suggestion ${suggestionId})` }).catch(() => undefined);
    return Response.json({ ok: true });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/contacts/suggestions/[id]");
  }
}
