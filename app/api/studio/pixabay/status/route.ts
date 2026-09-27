// Marketr — Pixabay configured-status endpoint (Phase 11 "Canvas").
// GET /api/studio/pixabay/status — { configured: boolean }. Lets the editor
// show an honest empty state without burning Pixabay quota. Never exposes
// key material.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { pixabayStatus } from "@/lib/design/pixabay";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace({ editor: true });
    return Response.json({ configured: pixabayStatus().configured });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
