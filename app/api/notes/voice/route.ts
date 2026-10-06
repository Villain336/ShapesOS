// ShapesOS — Phase 18.2 (WS=content): voice notes.
// POST /api/notes/voice  multipart: audio (WebM/Ogg/MP4/WAV/MP3 recording, ≤ 20 MB),
//        seconds (the recording's length, for metering), title?, links? (JSON)
//      → 201 { note } — the transcript becomes a private note.
//
// The browser records (MediaRecorder); the EXISTING transcription provider
// (lib/clipper/transcribe.ts, Whisper-class, TRANSCRIPTION_API_KEY →
// OPENAI_API_KEY → LLM_API_KEY) turns it into text. No key → 503 with the
// reason, never a fake transcript. A capped workspace is refused before the
// call (402); each started minute is metered (voice_note_minute). The audio
// itself is not kept — only the transcript.
// Access: guardWorkspace (any member writes their own notes); per-user write
// rate limit.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { noteActor } from "@/lib/notes/http";
import { createNote } from "@/lib/notes/service";
import { checkRateLimitAsync, rateLimitKey, tooManyRequests } from "@/lib/api/rate-limit";
import { BadRequestError } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "mp4",
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
};

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await noteActor(user.id, workspace.id);
    const limit = await checkRateLimitAsync(rateLimitKey("write", user.id, null), "write");
    if (!limit.allowed) return tooManyRequests(limit.retryAfterMs);
    const form = await req.formData().catch(() => null);
    if (!form) throw new BadRequestError("Expected multipart form data.");
    const audio = form.get("audio");
    if (!(audio instanceof File) || audio.size === 0) throw new BadRequestError("Missing the recording.");
    if (audio.size > MAX_AUDIO_BYTES) return Response.json({ error: "The recording is longer than this app takes (20 MB)." }, { status: 413 });
    const baseType = (audio.type || "").split(";")[0]!.trim().toLowerCase();
    const ext = AUDIO_TYPES[baseType];
    if (!ext) throw new BadRequestError("Unsupported recording format.");
    const seconds = Math.min(Math.max(Number(form.get("seconds")) || 0, 1), 60 * 60);
    let links: unknown = [];
    const rawLinks = form.get("links");
    if (typeof rawLinks === "string" && rawLinks.trim()) {
      try {
        links = JSON.parse(rawLinks);
      } catch {
        throw new BadRequestError("links must be JSON.");
      }
    }

    const { getTranscriptionProvider, TranscriptionNotConfiguredError } = await import("@/lib/clipper/transcribe");
    let provider;
    try {
      provider = getTranscriptionProvider();
    } catch (err) {
      if (err instanceof TranscriptionNotConfiguredError) {
        return Response.json(
          { error: "Voice notes need transcription. Set TRANSCRIPTION_API_KEY (or OPENAI_API_KEY) on the server.", code: "transcription_not_configured" },
          { status: 503 },
        );
      }
      throw err;
    }
    const { checkCap, meter } = await import("@/lib/metering/service");
    const cap = await checkCap(workspace.id);
    if (!cap.allowed) {
      return Response.json({ error: "This workspace reached its credit cap. Raise it in Settings → Usage to transcribe voice notes.", code: "cap_reached" }, { status: 402 });
    }
    const bytes = Buffer.from(await audio.arrayBuffer());
    const transcript = await provider.transcribe(bytes, { filename: `voice-note.${ext}`, mimeType: baseType });
    const minutes = Math.max(1, Math.ceil(seconds / 60));
    const { creditsFor } = await import("@/lib/metering/credits");
    await meter({
      workspaceId: workspace.id,
      actorId: user.id,
      action: "voice_note_minute",
      credits: creditsFor("voice_note_minute") * minutes,
      idempotencyKey: `voice-note:${user.id}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
      evidenceRef: `voice-note ${minutes} min`,
    }).catch(() => undefined);
    const text = transcript.text.trim();
    if (!text) return Response.json({ error: "No speech was heard in the recording." }, { status: 422 });
    const titleRaw = form.get("title");
    const note = await createNote({
      workspaceId: actor.workspaceId,
      createdBy: user.id,
      title: typeof titleRaw === "string" && titleRaw.trim() ? titleRaw.trim().slice(0, 200) : null,
      body: text,
      links: links as never,
      tags: ["voice"],
      sourceRef: "voice",
    });
    return Response.json({ note }, { status: 201 });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
