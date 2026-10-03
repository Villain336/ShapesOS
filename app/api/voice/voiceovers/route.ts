// Marketr — Phase 13D Worker B: voiceover jobs API.
// GET  /api/voice/voiceovers            → job list (newest first)
// POST /api/voice/voiceovers            → create job; pass { render: true }
//                                        to also render it synchronously and
//                                        return the final ready/failed row.

import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import {
  createVoiceoverJob,
  processVoiceoverJob,
  listVoiceoverJobs,
} from "@/lib/voice/voiceover";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const jobs = await listVoiceoverJobs(workspace.id);
    return Response.json({ jobs });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = (await readJson(req)) as {
      script?: unknown;
      voiceId?: unknown;
      agentId?: unknown;
      clipId?: unknown;
      render?: unknown;
    };
    const job = await createVoiceoverJob(workspace.id, {
      script: typeof body.script === "string" ? body.script : "",
      voiceId: typeof body.voiceId === "string" ? body.voiceId : "",
      agentId: typeof body.agentId === "string" ? body.agentId : undefined,
      clipId: typeof body.clipId === "string" ? body.clipId : undefined,
    });
    if (body.render === true) {
      const rendered = await processVoiceoverJob(workspace.id, job.id);
      return Response.json({ job: rendered }, { status: 201 });
    }
    return Response.json({ job }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
