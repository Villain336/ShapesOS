// Marketr — Brandfetch configured-status endpoint (Phase 11 "Canvas").
// GET /api/studio/brandfetch/status — { configured: boolean }. Lets the editor
// show an honest empty state without burning Brandfetch quota. Never exposes
// key material.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { brandfetchStatus } from "@/lib/design/brandfetch";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace({ editor: true });
    return Response.json({ configured: brandfetchStatus().configured });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
