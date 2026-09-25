// Marketr — studio creative Canva autofill (Phase 4, T2).
// POST /api/studio/creatives/canva/autofill { creativeId?, brandTemplateId, data } (editor)
// Enterprise-gated: 409 "requires Canva Enterprise" when the connected account
// lacks brand-template scopes. On success, links the new design to the draft
// creative (the export-pdf route pulls the PDF export afterwards).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { autofillStudioTemplate } from "@/lib/studio/service";
import { CreativeHttpError } from "@/lib/studio/creatives";
import {
  assertCanvaEnterprise,
  canvaClient,
  creativeErrorResponse,
  guardWorkspace,
  productionCanvaPort,
  readJson,
} from "../../_lib";

export const dynamic = "force-dynamic";

const AutofillSchema = z.object({
  creativeId: z.string().min(1).max(120).optional(),
  brandTemplateId: z.string().min(1).max(120),
  data: z.record(z.string(), z.object({
    type: z.enum(["text", "image"]),
    text: z.string().max(5000).optional(),
    assetId: z.string().max(120).optional(),
  })),
});

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    await assertCanvaEnterprise(workspace.id);
    const parsed = AutofillSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const { designId } = await autofillStudioTemplate(
      prisma,
      workspace.id,
      "",
      productionCanvaPort(),
      canvaClient(),
      { brandTemplateId: parsed.data.brandTemplateId, data: parsed.data.data },
    );
    if (parsed.data.creativeId) {
      const row = await prisma.mailCreative.findFirst({
        where: { id: parsed.data.creativeId, workspaceId: workspace.id },
      });
      if (!row) throw new CreativeHttpError(404, "Creative not found.");
      await prisma.mailCreative.update({
        where: { id: row.id },
        data: { canvaDesignId: designId },
      });
    }
    return Response.json({ designId });
  } catch (e) {
    return creativeErrorResponse(e);
  }
}
