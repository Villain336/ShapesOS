// ShapesOS — CAD derived BOM (Phase 4b).
// POST /api/cad/models/[id]/bom/derive — derive a new BOM version from one
//   model version's real mesh geometry (editor). Body:
//   { modelVersionId, materialKey?, customMaterial?: { label, densityGPerCm3 },
//     costPerKgUsd?, notes? }
//   201 → { bom, rollup, derivation }. STEP / unreadable geometry → 422
//   (nothing written). Emits the `cad.bom_derived` webhook after the write.

import { z } from "zod";
import { guardWorkspace, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadPipelineStore } from "@/lib/cad/pipeline-store";
import { cadRouteError } from "@/lib/cad/route-errors";
import { emitWebhookEvent } from "@/lib/webhooks/emit";
import { log } from "@/lib/observability/log";

export const dynamic = "force-dynamic";

const Body = z.object({
  modelVersionId: z.string().min(1).max(64),
  materialKey: z.string().max(40).nullish(),
  customMaterial: z
    .object({ label: z.string().max(80), densityGPerCm3: z.union([z.number(), z.string().max(20)]) })
    .nullish(),
  costPerKgUsd: z.union([z.number(), z.string().max(20)]).nullish(),
  notes: z.string().max(500).nullish(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const body = Body.parse(await readJson(req));
    const store = new PrismaCadPipelineStore(prisma);
    const result = await store.deriveBomFromGeometry(workspace.id, user.email ?? user.id, id, body.modelVersionId, {
      materialKey: body.materialKey,
      customMaterial: body.customMaterial,
      costPerKgUsd: body.costPerKgUsd,
      notes: body.notes,
    });
    await emitWebhookEvent({
      workspaceId: workspace.id,
      type: "cad.bom_derived",
      data: {
        bomId: result.bom.id,
        bomNumber: result.bom.bomNumber,
        modelId: result.bom.modelId,
        modelVersionId: result.bom.modelVersionId,
        versionNumber: result.derivation.sourceVersionNumber,
        lineCount: result.rollup.lineCount,
        bodyCount: result.derivation.bodyCount,
        material: result.derivation.material?.label ?? null,
        totalMassG: result.rollup.totalMassG,
        totalUsd: result.rollup.totalUsd,
        linesMissingCost: result.rollup.linesMissingCost,
      },
      dedupKey: `cad.bom_derived:${result.bom.id}`,
    });
    log.info("cad.bom_derived", {
      workspaceId: workspace.id,
      bomId: result.bom.id,
      lines: result.rollup.lineCount,
      bodies: result.derivation.bodyCount,
    });
    return Response.json(result, { status: 201 });
  } catch (e) {
    return cadRouteError(e, "POST /api/cad/models/[id]/bom/derive", req);
  }
}
