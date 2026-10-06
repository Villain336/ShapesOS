// ShapesOS — Phase 18.2 (WS=comms): triage my inbox with an agent.
//   POST /api/comms/mail/triage → 202 { runId, threadId, projectId }   (editor+)
// A delegated agent run (the Drafter, email + workspace tools only): it reads,
// summarizes, suggests labels and drafts replies — drafts only, every send
// still goes through the tier gate. Watch or stop it on its run page.

import { errorResponse } from "@/lib/api/errors";
import { startTriage } from "@/lib/comms/mail/agent.server";
import { mailGuard } from "../_lib";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const ctx = await mailGuard("editor");
    const out = await startTriage(ctx.mail);
    return Response.json(out, { status: 202 });
  } catch (err) {
    return errorResponse(err, "POST /api/comms/mail/triage");
  }
}
