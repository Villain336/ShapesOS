// Marketr — Penpot configured-status endpoint (Phase 12 "Reconsider trio").
// GET /api/studio/penpot/status — { configured, betaNote }. Lets the editor
// show an honest empty state without hitting Penpot. Never exposes key
// material.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { penpotStatus } from "@/lib/design/penpot";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace({ editor: true });
    const { configured, betaNote } = penpotStatus();
    return Response.json({ configured, betaNote });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
