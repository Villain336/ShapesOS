// Marketr — Phase 13D Worker B: VoiceStudio voice discovery API.
// GET /api/voice/voices → the discovered VoiceStudio voice list
// (never invented ids — straight from GET /v1/audio/voices, cached).

import {
  guardWorkspace,
  httpErrorResponse,
} from "@/lib/enrichment/guard";
import {
  listVoices,
  voiceStudioUrl,
  VoiceStudioError,
} from "@/lib/voice/voicestudio";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    await guardWorkspace();
    const voices = await listVoices();
    return Response.json({
      backend: "voicestudio",
      backendUrl: voiceStudioUrl(),
      voices: voices.map((v) => ({
        voice_id: v.voice_id,
        name: v.name,
        type: v.type,
        description: v.description ?? null,
      })),
    });
  } catch (e) {
    if (e instanceof VoiceStudioError && e.kind === "down") {
      return Response.json(
        { error: e.message, backend: "voicestudio", voices: [] },
        { status: 502 },
      );
    }
    return httpErrorResponse(e);
  }
}
