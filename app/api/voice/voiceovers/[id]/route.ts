// Marketr — Phase 13D Worker B: single voiceover job API.
// GET    /api/voice/voiceovers/[id]          → job status/detail
// GET    /api/voice/voiceovers/[id]?audio=1  → the rendered WAV bytes
// POST   /api/voice/voiceovers/[id]          → { action: "process" | "attach", clipId? }
// DELETE /api/voice/voiceovers/[id]          → delete job + stored audio

import {
  guardWorkspace,
  httpErrorResponse,
  readJson,
} from "@/lib/enrichment/guard";
import {
  getVoiceoverJob,
  processVoiceoverJob,
  attachJobToClip,
  getJobAudio,
  deleteVoiceoverJob,
} from "@/lib/voice/voiceover";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function notFound() {
  return Response.json({ error: "Voiceover job not found." }, { status: 404 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const job = await getVoiceoverJob(workspace.id, id);
    if (!job) return notFound();

    if (new URL(req.url).searchParams.get("audio") === "1") {
      if (job.status !== "ready") {
        return Response.json(
          { error: `Audio is not available (job status: ${job.status}).` },
          { status: 409 },
        );
      }
      const audio = await getJobAudio(workspace.id, id);
      if (!audio) return notFound();
      return new Response(audio.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": audio.mime,
          "content-length": String(audio.bytes.length),
          "content-disposition": `attachment; filename="voiceover-${id}.wav"`,
        },
      });
    }
    return Response.json({ job });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as { action?: unknown; clipId?: unknown };
    if (body.action === "process") {
      const job = await processVoiceoverJob(workspace.id, id);
      return Response.json({ job });
    }
    if (body.action === "attach") {
      if (typeof body.clipId !== "string" || !body.clipId) {
        return Response.json({ error: "clipId is required." }, { status: 400 });
      }
      const job = await attachJobToClip(workspace.id, id, body.clipId);
      return Response.json({ job });
    }
    return Response.json(
      { error: "Unknown action. Use 'process' or 'attach'." },
      { status: 400 },
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : "Internal error";
    const status = /not found/i.test(message) ? 404 : 500;
    return Response.json({ error: message }, { status });
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    await deleteVoiceoverJob(workspace.id, id);
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
