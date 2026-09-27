// Marketr — studio Colormind palette-generation API (Phase 11 "Canvas").
// POST /api/studio/colormind/generate {input: [...], model?}
//
// FAIL CLOSED (2026-09-27, license verification): Colormind's own API docs
// (http://colormind.io/api-access/) state the free API is "free for personal
// and non-commercial use" and commercial use requires contacting the
// operator (jack@colormind.io). Marketr ships a commercial tier, so this
// route is deliberately disabled: it answers 503 and NEVER calls
// colormind.io. The request-shaping code in lib/design/colormind.ts stays
// pure and tested so the day a written commercial agreement exists, the only
// delta is flipping COLORMIND_ENABLED — plus a meter("colormind_palette")
// call per tenant before the upstream fetch (see brief §15 item 2).

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { COLORMIND_DISABLED_REASON, colormindStatus } from "@/lib/design/colormind";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await guardWorkspace({ editor: true });
    const status = colormindStatus();
    if (!status.enabled) {
      return Response.json(
        {
          error: COLORMIND_DISABLED_REASON,
          code: "colormind_disabled",
        },
        { status: 503 },
      );
    }
    // Unreachable while the kill-switch is off; kept for the enabled path.
    return Response.json(
      { error: "Colormind is enabled in code but the live path is not wired.", code: "colormind_unwired" },
      { status: 501 },
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}
