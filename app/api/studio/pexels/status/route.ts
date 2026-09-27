// Marketr — Pexels configured-status endpoint (Phase 11 "Canvas").
// GET /api/studio/pexels/status — { configured: boolean }. Lets the editor
// show an honest empty state without burning Pexels quota. Never exposes
// key material.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { pexelsStatus } from "@/lib/design/pexels";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace({ editor: true });
    return Response.json({ configured: pexelsStatus().configured });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
