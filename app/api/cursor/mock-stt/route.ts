// ShapesOS — Phase 19A (WS=server): GET /api/cursor/mock-stt — the LABELLED
// mock speech-to-text stream (ALLOW_FAKE_PROVIDERS=1 only; 404 otherwise).
// Next route handlers cannot upgrade to a WebSocket, so the mock streams the
// scripted transcript as Server-Sent Events in AssemblyAI v3 message shape
// ({ type: "Begin" | "Turn" | "Termination", transcript, end_of_turn,
// mock: true }) and the desktop reads it with fetch when provider is "mock".
// Read-only; the caller must be signed in (cookie or cursor token).

import { requireWorkspaceRole } from "@/lib/authz";
import { cursorErrorResponse, forbiddenCursor, resolveCursorCaller } from "@/lib/cursor/http";
import { cursorMocksAllowed, mockSttMessages } from "@/lib/voice/stt";
import { SSE_HEADERS, formatSseEvent } from "@/lib/http/sse";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!cursorMocksAllowed()) return Response.json({ error: { code: "not_found", message: "Not found." } }, { status: 404 });
  try {
    const caller = await resolveCursorCaller(req);
    if (!(await requireWorkspaceRole(caller.userId, caller.workspaceId, "viewer"))) throw forbiddenCursor();
    const text = mockSttMessages().map((m) => formatSseEvent("message", m)).join("");
    return new Response(text, { headers: { ...SSE_HEADERS, "X-Shapes-Mock": "1" } });
  } catch (err) {
    return cursorErrorResponse(err);
  }
}
