// ShapesOS — Phase 18.2 (WS=comms): take one record back out of a merged contact.
//   POST /api/comms/contacts/[id]/unlink { kind, recordId } → { identityId }   (editor+)
// The record gets its own contact again and the pair is remembered as "not
// the same person", so it is never suggested again.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { unlinkRecord } from "@/lib/comms/contacts/store";
import { RECORD_KINDS } from "@/lib/comms/contacts/match";
import { auditEvent } from "@/lib/auditlog";
import { commsGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ kind: z.enum(RECORD_KINDS), recordId: z.string().min(1).max(64) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await commsGuard("editor");
    const { id } = await params;
    const parsed = validateBody(Body, await req.json());
    if (!parsed.ok) return parsed.error;
    const out = await withWorkspaceScope(ctx.workspaceId, (tx) =>
      unlinkRecord(tx, { workspaceId: ctx.workspaceId, identityId: String(id).slice(0, 64), kind: parsed.data.kind, id: parsed.data.recordId, userId: ctx.userId }),
    );
    await auditEvent({ projectId: null, workspaceId: ctx.workspaceId, actorUserId: ctx.userId, action: "contact_unlinked", summary: `Unlinked ${parsed.data.kind} ${parsed.data.recordId} from contact ${id}` }).catch(() => undefined);
    return Response.json(out);
  } catch (err) {
    return errorResponse(err, "POST /api/comms/contacts/[id]/unlink");
  }
}
