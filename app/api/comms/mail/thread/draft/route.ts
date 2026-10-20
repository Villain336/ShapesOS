// ShapesOS — Phase 18.2 (WS=comms): the inbox agent drafts a reply.
//   POST /api/comms/mail/thread/draft?key=… { instructions? } → 201 { draft, mock }   (viewer+)
// A draft only — nothing is sent; you review it in the composer and press Send.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";
import { draftReply } from "@/lib/comms/mail/agent.server";
import { keyParam, mailGuard } from "../../_lib";

export const dynamic = "force-dynamic";

const Body = z.object({ instructions: z.string().max(500).optional() });

export async function POST(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    const raw = await req.text();
    const parsed = validateBody(Body, raw ? JSON.parse(raw) : {});
    if (!parsed.ok) return parsed.error;
    const out = await draftReply(ctx.mail, keyParam(req.nextUrl), { instructions: parsed.data.instructions ?? null, agentKey: "drafter" });
    return Response.json(out, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/mail/thread/draft");
  }
}
