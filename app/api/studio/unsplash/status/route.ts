// Marketr — Unsplash configured-status endpoint (Phase 11 "Canvas").
// GET /api/studio/unsplash/status — { configured: boolean }. Lets the editor
// show an honest empty state without burning Unsplash quota. Never exposes
// key material.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { unsplashStatus } from "@/lib/design/unsplash";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace({ editor: true });
    return Response.json({ configured: unsplashStatus().configured });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
