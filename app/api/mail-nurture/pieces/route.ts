// Marketr — R3 mail channel: nurture mail pieces API.
// GET /api/mail-nurture/pieces → nurture mail pieces for the workspace, read
// from T1's tables (MailCampaign audienceSource.kind == "nurture_step" +
// MailPiece + latest MailApproval). Standalone mail campaigns are Track T1:
// app/api/mail/campaigns/**.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { getNurtureMailPieces } from "@/lib/messaging/mail-channel";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const pieces = await getNurtureMailPieces(workspace.id, 200);
    return Response.json({ pieces });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
