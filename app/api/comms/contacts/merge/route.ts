// ShapesOS — Phase 18.2 (WS=comms): a person merges two contacts by hand.
//   POST /api/comms/contacts/merge { a: { kind, id }, b: { kind, id } } → { identityId }   (editor+)
// The person's click is the confirmation: a suggestion is recorded (via
// "person") and confirmed in the same transaction. A pair someone rejected
// before is refused (409) — unlinking is how a rejection is undone.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { confirmSuggestion, ContactsError, identityForRecord, proposeMerge } from "@/lib/comms/contacts/store";
import { RECORD_KINDS } from "@/lib/comms/contacts/match";
import { auditEvent } from "@/lib/auditlog";
import { commsGuard } from "../../_lib";

export const dynamic = "force-dynamic";

const Side = z.object({ kind: z.enum(RECORD_KINDS), id: z.string().min(1).max(64) });
const Body = z.object({ a: Side, b: Side });

export async function POST(req: NextRequest) {
  try {
    const ctx = await commsGuard("editor");
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const { a, b } = parsed.data;
    const out = await withWorkspaceScope(ctx.workspaceId, async (tx) => {
      const p = await proposeMerge(tx, { workspaceId: ctx.workspaceId, a, b, via: "person" });
      if (p.outcome === "already_merged") return { identityId: await identityForRecord(tx, ctx.workspaceId, a.kind, a.id) };
      if (p.outcome === "previously_rejected") throw new ContactsError(409, "Someone marked these as different people. Unlink is the only way to change that.");
      if (!p.suggestion) throw new ContactsError(404, "Contact not found.");
      return confirmSuggestion(tx, { workspaceId: ctx.workspaceId, suggestionId: p.suggestion.id, userId: ctx.userId });
    });
    await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "contact_merge_confirmed", summary: `Merged ${a.kind} ${a.id} with ${b.kind} ${b.id}` }).catch(() => undefined);
    return Response.json(out);
  } catch (err) {
    return errorResponse(err, "POST /api/comms/contacts/merge");
  }
}
