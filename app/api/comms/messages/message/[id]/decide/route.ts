// ShapesOS — Phase 18.2 (WS=comms): decide an agent's inline proposal.
//   POST /api/comms/messages/message/[id]/decide { decision: "approve" | "discard" } → { meta }
// Editor+, and the person who asked the agent (or an admin). Approve sends
// the chat's "yes" on the agent worker — executeTool runs the proposal as
// you, with your role; Discard drops it.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { decideProposal } from "@/lib/comms/messages/agent.server";
import { idParam, messagesGuard } from "../../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ decision: z.enum(["approve", "discard"]) }).strict();

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await messagesGuard();
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    return Response.json({ meta: await decideProposal(ctx, idParam((await params).id), parsed.data.decision) });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/messages/message/[id]/decide");
  }
}
