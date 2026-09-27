// Marketr — Cloudinary configured-status endpoint (Phase 11 "Canvas",
// integration #7).
// GET /api/studio/cloudinary/status — { configured: boolean }. Lets the
// Uploads panel pick the upload pipeline (signed Cloudinary) vs the local
// data-URL fallback without leaking anything. Never exposes key material.

import { guardWorkspace, httpErrorResponse } from "../../designs/_lib";
import { cloudinaryStatus } from "@/lib/design/cloudinary";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await guardWorkspace({ editor: true });
    return Response.json({ configured: cloudinaryStatus().configured });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
