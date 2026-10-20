// ShapesOS — GET /api/account/export (Phase 4a, GDPR access/portability).
// The signed-in user's own data as one streamed JSON document
// (lib/gdpr/user-export.ts). Self-service: no id is read from the request;
// everything is keyed to the session's own subject.

import { requireSelfService } from "@/lib/auth/require-self-service";
import { errorResponse } from "@/lib/api/errors";
import { log, requestIdFrom } from "@/lib/observability/log";
import { exportFilename } from "@/lib/gdpr/workspace-export";
import { userExport } from "@/lib/gdpr/user-export";
import { textStream } from "@/lib/gdpr/stream";
import { claimExportSlot, releasingStream } from "@/lib/gdpr/limit";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const me = await requireSelfService();
    if (me instanceof Response) return me;
    const slot = `user:${me.id}`;
    if (!(await claimExportSlot(slot))) {
      return Response.json({ error: "Your export is already running. Try again when it finishes." }, { status: 429 });
    }
    const now = new Date();
    const requestId = requestIdFrom(req);
    const gen = userExport(me, now);
    const logged = (async function* () {
      try {
        yield* gen;
      } catch (err) {
        log.error("account export failed mid-stream", { requestId, err });
        throw err;
      }
    })();
    return new Response(releasingStream(textStream(logged), slot), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFilename("account", "my-data", now)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    return errorResponse(err, "GET /api/account/export", req);
  }
}
