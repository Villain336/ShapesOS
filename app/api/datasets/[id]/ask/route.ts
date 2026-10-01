// Marketr — Dataset Builder slice 4 API.
// POST /api/datasets/[id]/ask — grounded question answering over the
// dataset's live RAG snapshot. Every answer cites Source → Document →
// Chunk; when nothing matches, the answer says so instead of guessing.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { askDataset } from "@/lib/datasetbuilder/activate";
import { DatasetBuilderError } from "@/lib/datasetbuilder/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  question: z.string().min(1).max(2000),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const body = BodySchema.parse(await req.json().catch(() => ({})));
    const store = new PrismaDatasetBuilderStore(prisma);

    try {
      const result = await askDataset(
        store,
        workspace.id,
        id,
        body.question,
      );
      return Response.json(result);
    } catch (e) {
      if (e instanceof DatasetBuilderError) {
        if (e.code === "UNKNOWN_DATASET") {
          return Response.json({ error: "Dataset not found" }, { status: 404 });
        }
        if (
          e.code === "NO_VERSION_TO_PUBLISH" ||
          e.code === "LINEAGE_BROKEN"
        ) {
          return Response.json({ error: e.message }, { status: 422 });
        }
      }
      throw e;
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}
