// ShapesOS — Phase 19B (WS=engine): a town run as Server-Sent Events.
// GET /api/rehearsal/town/runs/:id/stream?variant=A|B&from=<sim minute>
// Planned paths with timestamps + decisions, paged; Last-Event-ID resume,
// heartbeats and drain from lib/http/sse.ts (lib/sim/stream.server.ts). Viewer+.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { lastEventIdOf, sseResponse } from "@/lib/http/sse";
import { townActor } from "@/lib/sim/http.server";
import { streamTownRun } from "@/lib/sim/stream.server";

export const dynamic = "force-dynamic";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace();
    const actor = await townActor(user.id, workspace.id);
    const { id } = await params;
    const url = new URL(req.url);
    const variant = url.searchParams.get("variant") === "B" ? "B" : "A";
    const from = Number(url.searchParams.get("from"));
    const lastEventId = lastEventIdOf(req);
    return sseResponse(
      async (ch) => {
        try {
          await streamTownRun(actor, id, { variant, fromMinute: Number.isFinite(from) ? from : null, lastEventId }, ch);
        } catch (err) {
          ch.send("error", { message: err instanceof Error ? err.message : "stream failed" });
        }
      },
      { lastEventId },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}
