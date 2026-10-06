// ShapesOS — Phase 19A (WS=server): the person's cursor voice
// (Settings → You → Cursor).
// GET  /api/cursor/voices → { provider, voices: [{ id, label }], selected }
//      — the TTS provider's OWN voice list (ElevenLabs / VoiceStudio
//      discovered, OpenAI's documented built-ins); never invented ids.
// PUT  /api/cursor/voices { voiceId } → { selected } — saved in
//      UserPreference.voice.cursor; only an id the provider lists.
// Any member, for their own preference (roleAtLeast viewer on the current membership).

import { roleAtLeast } from "@/lib/authz";
import { CursorHttpError, cursorErrorResponse, forbiddenCursor, readCursorJson, resolveCursorCaller } from "@/lib/cursor/http";
import { listTtsVoices, ttsProviderName } from "@/lib/voice/tts";
import { getCursorVoice, setCursorVoice } from "@/lib/cursor/session";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!roleAtLeast(caller.role, "viewer")) throw forbiddenCursor();
    const provider = ttsProviderName();
    let voices: Array<{ id: string; label: string }> = [];
    let error: string | null = null;
    if (provider !== "none") {
      voices = await listTtsVoices(provider).catch((e: unknown) => {
        error = e instanceof Error ? e.message : "The voice list could not be read.";
        return [];
      });
    }
    const saved = await getCursorVoice(caller.userId).catch(() => null);
    return Response.json({ provider, voices, selected: saved && saved.provider === provider ? saved : null, error });
  } catch (err) {
    return cursorErrorResponse(err);
  }
}

export async function PUT(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!roleAtLeast(caller.role, "viewer")) throw forbiddenCursor();
    const body = (await readCursorJson(req, 4 * 1024)) as { voiceId?: unknown };
    if (typeof body?.voiceId !== "string" || !body.voiceId.trim()) throw new CursorHttpError(400, "bad_request", "Send { voiceId }.");
    const selected = await setCursorVoice(caller.userId, body.voiceId.trim());
    return Response.json({ selected });
  } catch (err) {
    return cursorErrorResponse(err);
  }
}
