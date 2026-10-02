// Marketr — Funding/VC slice 4 API.
// GET /api/funding/rounds/[id]/safe-templates — the SAFE template catalog
//       (valuation cap / discount / cap+discount / MFN). Templates are
//       general information, never legal advice — the label ships here.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import {
  SAFE_TEMPLATES,
  SAFE_NOT_ADVICE_LABEL,
} from "@/lib/funding/safe-templates";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    return Response.json({
      workspaceId: workspace.id,
      templates: SAFE_TEMPLATES,
      notAdviceLabel: SAFE_NOT_ADVICE_LABEL,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
