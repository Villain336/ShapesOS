// ShapesOS — Phase 19A (WS=server): POST /api/cursor/turn → text/event-stream.
// Body: { conversationId?, transcript, screenshots: [{ screen, width, height,
// scaleFactor, primary, jpegBase64 }], uiMap?, app?, mode?, talkSeconds? }.
// ≤ 4 screenshots and ≤ 6 MB of them, else 413. Events (one JSON object per
// data: line, named by event:): turn_started, text_delta, point, draw,
// proposal, dictation, agent_started, error, done — heartbeats every 15 s
// (lib/http/sse.ts). The model's tags are parsed here (lib/cursor/tags.ts);
// the desktop never parses model text.
//
// Screenshots are used for this call only and NEVER stored: not on the run,
// not in a transcript, not in the audit, not in a log. The run timeline gets
// a ≤ 200-char text summary.
//
// Access: any member may ask (a viewer gets answers and pointing, no
// tools); mode "agent" and acting need editor+ (403). Rate limit: the "ai"
// tier (proxy.ts). The brain's model calls are gated by the credit cap
// before they are sent and metered as llm_tokens (0 credits on the
// workspace's own model key); talk minutes past the first are metered from
// talkSeconds, checked before the model is called.

import { randomBytes } from "node:crypto";
import { requireWorkspaceRole } from "@/lib/authz";
import { CursorHttpError, cursorErrorResponse, forbiddenCursor, readCursorJson, resolveCursorCaller } from "@/lib/cursor/http";
import { MAX_TURN_BODY_BYTES, TurnBodySchema, screenshotLimitError } from "@/lib/cursor/validate";
import { CursorTurnError, cursorVisionProvider, runCursorTurn } from "@/lib/cursor/brain";
import { preflightTalkMinutes, recordTalkMinutes, startedMinutes } from "@/lib/cursor/metering";
import { sttProviderName } from "@/lib/voice/stt";
import { SSE_HEADERS, sseStream } from "@/lib/http/sse";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(req: Request) {
  try {
    const caller = await resolveCursorCaller(req);
    if (!(await requireWorkspaceRole(caller.userId, caller.workspaceId, "viewer"))) throw forbiddenCursor("You are not a member of this workspace.");
    const raw = await readCursorJson(req, MAX_TURN_BODY_BYTES);
    const parsed = TurnBodySchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new CursorHttpError(400, "bad_request", `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`);
    }
    const body = parsed.data;
    const tooBig = screenshotLimitError(body.screenshots);
    if (tooBig) throw new CursorHttpError(413, "too_large", tooBig);
    if (new Set(body.screenshots.map((s) => s.screen)).size !== body.screenshots.length) {
      throw new CursorHttpError(400, "bad_request", "Each screenshot needs its own screen number.");
    }
    if (body.mode === "agent" && !(await requireWorkspaceRole(caller.userId, caller.workspaceId, "editor"))) {
      throw forbiddenCursor("Viewers can't start background tasks.");
    }
    if ((await cursorVisionProvider(caller.workspaceId)) === "none") {
      throw new CursorHttpError(503, "vision_not_configured", "The cursor's model is not configured on this server.");
    }
    // Talk minutes past the one charged with the transcribe token.
    const stt = sttProviderName();
    const extraMinutes = body.talkSeconds !== undefined && stt !== "none" ? startedMinutes(body.talkSeconds) - 1 : 0;
    const talkCharges = extraMinutes > 0 && stt !== "none" ? await preflightTalkMinutes(caller.workspaceId, extraMinutes, stt) : [];
    const turnKey = `turn_${randomBytes(9).toString("base64url")}`;

    const stream = sseStream(async (ch) => {
      try {
        await runCursorTurn(
          { userId: caller.userId, workspaceId: caller.workspaceId, role: caller.role },
          {
            conversationId: body.conversationId ?? null,
            transcript: body.transcript,
            screenshots: body.screenshots,
            uiMap: body.uiMap,
            app: body.app ?? null,
            mode: body.mode ?? "answer",
          },
          (e) => void ch.send(e.event, e.data),
          {},
          ch.signal,
        );
        if (talkCharges.length && stt !== "none") {
          await recordTalkMinutes({ workspaceId: caller.workspaceId, actorId: caller.userId, sessionKey: turnKey, fromMinute: 2, charges: talkCharges, provider: stt });
        }
      } catch (err) {
        const e = err instanceof CursorTurnError ? err : null;
        ch.send("error", { code: e?.code ?? "internal", message: e?.message ?? "The turn failed. Try again." });
        ch.send("done", { usage: { credits: 0, inputTokens: 0, outputTokens: 0 } });
        if (!e) console.error("[cursor] turn failed", err);
      }
    });
    return new Response(stream, { headers: SSE_HEADERS });
  } catch (err) {
    return cursorErrorResponse(err);
  }
}
