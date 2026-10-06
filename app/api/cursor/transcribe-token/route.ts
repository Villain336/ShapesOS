// ShapesOS — Phase 19A (WS=server): POST /api/cursor/transcribe-token
// → { provider, wsUrl, token, expiresAt, sampleRate: 16000, encoding: "pcm_s16le", authVia, sessionId }
// A short-lived streaming STT token minted from the PLATFORM key
// (lib/voice/stt.ts: AssemblyAI, or Deepgram); the key never leaves the
// server. One token = one hold-to-talk session. Its first started minute is
// metered here (cursor_talk_minute: free within the plan's included minutes,
// then credits) and refused BEFORE minting when the credits can't cover it
// (402 cap_reached); later minutes are reported with the turn
// (talkSeconds). No key → 503 stt_not_configured ("not configured" on the
// desktop) — a labelled mock only with ALLOW_FAKE_PROVIDERS=1.

import { randomBytes } from "node:crypto";
import { requireWorkspaceRole } from "@/lib/authz";
import { cursorErrorResponse, forbiddenCursor, resolveCursorCaller } from "@/lib/cursor/http";
import { mintSttToken, sttProviderName } from "@/lib/voice/stt";
import { preflightTalkMinutes, recordTalkMinutes } from "@/lib/cursor/metering";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!(await requireWorkspaceRole(caller.userId, caller.workspaceId, "viewer"))) throw forbiddenCursor("You are not a member of this workspace.");
    const provider = sttProviderName();
    if (provider === "none") {
      return Response.json(
        { error: { code: "stt_not_configured", message: "Speech input is not configured on this server." } },
        { status: 503 },
      );
    }
    const charges = await preflightTalkMinutes(caller.workspaceId, 1, provider);
    const origin = new URL(req.url).origin;
    const minted = await mintSttToken({ mockUrl: `${origin}/api/cursor/mock-stt` });
    const sessionId = `stt_${randomBytes(9).toString("base64url")}`;
    await recordTalkMinutes({ workspaceId: caller.workspaceId, actorId: caller.userId, sessionKey: sessionId, fromMinute: 1, charges, provider: minted.provider });
    return Response.json({ ...minted, sessionId }, { headers: { "Cache-Control": "no-store", ...(minted.mock ? { "X-Shapes-Mock": "1" } : {}) } });
  } catch (err) {
    return cursorErrorResponse(err);
  }
}
