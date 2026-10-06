// ShapesOS — Phase 19A (WS=server): POST /api/cursor/tts { text, voice? }
// → a streamed audio/mpeg body. Header X-Shapes-TTS-Provider names who
// spoke; X-Shapes-Mock: 1 marks the labelled mock (a short silent clip,
// ALLOW_FAKE_PROVIDERS=1 only). ≤ 2,000 characters per call.
// Provider order: ElevenLabs → VoiceStudio → OpenAI (lib/voice/tts.ts),
// platform keys only. Metered as cursor_tts_1k_chars (every started 1,000
// characters at the provider's cost-plus price), checked against the credits
// BEFORE the provider is called. The voice is `voice` when given, else the
// person's choice in Settings → You → Cursor; never an invented id.
// Any member (requireWorkspaceRole viewer).

import { randomBytes } from "node:crypto";
import { requireWorkspaceRole } from "@/lib/authz";
import { CursorHttpError, cursorErrorResponse, forbiddenCursor, readCursorJson, resolveCursorCaller } from "@/lib/cursor/http";
import { TtsBodySchema } from "@/lib/cursor/validate";
import { synthesizeSpeech, ttsProviderChain, ELEVENLABS_DEFAULT_MODEL } from "@/lib/voice/tts";
import { preflightTts, recordTts, ttsCredits } from "@/lib/cursor/metering";
import { getCursorVoice } from "@/lib/cursor/session";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!(await requireWorkspaceRole(caller.userId, caller.workspaceId, "viewer"))) throw forbiddenCursor("You are not a member of this workspace.");
    const parsed = TtsBodySchema.safeParse(await readCursorJson(req, 32 * 1024));
    if (!parsed.success) throw new CursorHttpError(parsed.error.issues.some((i) => i.code === "too_big") ? 413 : 400, "bad_request", "Send { text } with at most 2,000 characters.");
    const chain = ttsProviderChain();
    if (chain.length === 0) throw new CursorHttpError(503, "tts_not_configured", "Spoken answers are not configured on this server.");
    const text = parsed.data.text;
    // The dearest provider the chain may fall through to bounds the check.
    const worst = Math.max(...chain.map((p) => ttsCredits(p, p === "elevenlabs" ? (process.env.ELEVENLABS_MODEL_ID?.trim() || ELEVENLABS_DEFAULT_MODEL) : null, text.length)));
    await preflightTts(caller.workspaceId, worst);
    const saved = parsed.data.voice ? null : await getCursorVoice(caller.userId).catch(() => null);
    const out = await synthesizeSpeech({
      text,
      voice: parsed.data.voice ?? saved?.id ?? null,
      voiceProvider: parsed.data.voice ? chain[0] : (saved?.provider ?? null),
    });
    const credits = ttsCredits(out.provider, out.model, out.chars);
    await recordTts({
      workspaceId: caller.workspaceId,
      actorId: caller.userId,
      idempotencyKey: `cursor-tts:${randomBytes(12).toString("base64url")}`,
      credits,
      provider: out.provider,
      chars: out.chars,
    }).catch(() => undefined);
    return new Response(out.body, {
      headers: {
        "Content-Type": out.contentType,
        "Cache-Control": "no-store",
        "X-Shapes-TTS-Provider": out.provider,
        ...(out.mock ? { "X-Shapes-Mock": "1" } : {}),
      },
    });
  } catch (err) {
    const e = err as { name?: string; status?: number; code?: string; message?: string };
    if (e?.name === "TtsError") return cursorErrorResponse(new CursorHttpError(e.status ?? 502, e.code ?? "tts_provider_error", e.message ?? "Speech failed."));
    return cursorErrorResponse(err);
  }
}
