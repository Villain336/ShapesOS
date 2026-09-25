// Marketr — studio creative Canva brand templates (Phase 4, T2).
// GET /api/studio/creatives/canva/templates
// Enterprise-gated: returns a clean 409 ("requires Canva Enterprise") when the
// connected account lacks brand-template scopes — never faked.

import { prisma } from "@/lib/prisma";
import { listStudioBrandTemplates } from "@/lib/studio/service";
import {
  assertCanvaEnterprise,
  canvaClient,
  creativeErrorResponse,
  guardWorkspace,
  productionCanvaPort,
} from "../../_lib";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    await assertCanvaEnterprise(workspace.id);
    const result = await listStudioBrandTemplates(
      prisma,
      workspace.id,
      productionCanvaPort(),
      canvaClient(),
    );
    return Response.json(result);
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
