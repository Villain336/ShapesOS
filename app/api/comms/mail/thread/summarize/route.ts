// ShapesOS — Phase 18.2 (WS=comms): the inbox agent summarizes a thread.
//   POST /api/comms/mail/thread/summarize?key=… → { summary, suggestedTags, mock }   (viewer+)
// The workspace's background model (metered). Labels are suggestions a
// person accepts; a mock model's answer is flagged.

import type { NextRequest } from "next/server";
import { errorResponse } from "@/lib/api/errors";
import { summarizeThread } from "@/lib/comms/mail/agent.server";
import { keyParam, mailGuard } from "../../_lib";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const ctx = await mailGuard("viewer");
    return Response.json(await summarizeThread(ctx.mail, keyParam(req.nextUrl)));
  } catch (err) {
    return errorResponse(err, "POST /api/comms/mail/thread/summarize");
  }
}
