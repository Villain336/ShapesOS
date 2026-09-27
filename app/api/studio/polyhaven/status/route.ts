// Marketr — Poly Haven configured-status endpoint (Phase 11 "Canvas").
// GET /api/studio/polyhaven/status — { configured: boolean }. Poly Haven
// needs no key, so this is always true; it exists to keep the panel's
// source-availability checks uniform with the keyed providers and to keep
// the ToS credit constants server-side.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { POLY_HAVEN_CREDIT, POLY_HAVEN_URL } from "@/lib/design/polyhaven";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace({ editor: true });
    return Response.json({ configured: true, credit: POLY_HAVEN_CREDIT, creditUrl: POLY_HAVEN_URL });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
