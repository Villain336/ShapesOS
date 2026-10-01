// Marketr — Dataset Builder slice 2 API.
// POST /api/datasets/classify — run classification over unclassified chunks.
//   JSON body: { documentId?: string } — one document, or the whole
//   workspace when omitted.
// Every run uses the same pipeline (structure.ts), so the trust-ladder rule
// holds identically from the UI and the API: low confidence → ReviewItem,
// never force-fit.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { RulesClassificationEngine } from "@/lib/datasetbuilder/classify";
import {
  structureDocument,
  structureWorkspace,
} from "@/lib/datasetbuilder/structure";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  documentId: z.string().min(1).max(100).optional(),
});

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = BodySchema.parse(await req.json().catch(() => ({})));
    const store = new PrismaDatasetBuilderStore(prisma);
    const engine = new RulesClassificationEngine();

    let applied = 0;
    let queued = 0;
    if (body.documentId) {
      const document = await store.getDocument(body.documentId);
      if (!document || document.workspaceId !== workspace.id) {
        return Response.json({ error: "document not found" }, { status: 404 });
      }
      const results = await structureDocument(
        store,
        engine,
        body.documentId,
      );
      for (const r of results) {
        if (r.classification.status === "applied") applied += 1;
        else if (r.classification.status === "pending_review") queued += 1;
      }
      return Response.json({
        documentId: body.documentId,
        classified: results.length,
        applied,
        queued,
      });
    }

    const results = await structureWorkspace(store, engine, workspace.id);
    for (const r of results) {
      if (r.classification.status === "applied") applied += 1;
      else if (r.classification.status === "pending_review") queued += 1;
    }
    return Response.json({
      classified: results.length,
      applied,
      queued,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
