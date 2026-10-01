// Marketr — Dataset Builder slice 3 API.
// POST /api/datasets/compile — compile dataset types into new versions.
//   JSON body: { type?: DatasetType | "all" } — defaults to "all".
// Types with no applied classifications are skipped (reported), not
// failed; a single-type compile with nothing classified returns 422.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import { DATASET_TYPES, DATASET_TYPE_LABELS } from "@/lib/datasetbuilder/classify";
import { compileDataset, compileDatasets } from "@/lib/datasetbuilder/build";
import { DatasetBuilderError } from "@/lib/datasetbuilder/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  type: z.enum([...DATASET_TYPES, "all"] as const).default("all"),
});

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const body = BodySchema.parse(await req.json().catch(() => ({})));
    const store = new PrismaDatasetBuilderStore(prisma);

    if (body.type !== "all") {
      try {
        const result = await compileDataset(store, workspace.id, body.type);
        return Response.json({
          compiled: [
            {
              datasetId: result.dataset.id,
              type: result.dataset.type,
              label: DATASET_TYPE_LABELS[result.dataset.type],
              version: result.version.version,
              chunkCount: result.chunkCount,
              compiledAt: result.version.compiledAt.toISOString(),
            },
          ],
          skipped: [],
        });
      } catch (e) {
        if (e instanceof DatasetBuilderError && e.code === "COMPILE_EMPTY") {
          return Response.json(
            { error: `No classified chunks for type "${body.type}" yet` },
            { status: 422 },
          );
        }
        throw e;
      }
    }

    const { compiled, skipped } = await compileDatasets(store, workspace.id);
    return Response.json({
      compiled: compiled.map((r) => ({
        datasetId: r.dataset.id,
        type: r.dataset.type,
        label: DATASET_TYPE_LABELS[r.dataset.type],
        version: r.version.version,
        chunkCount: r.chunkCount,
        compiledAt: r.version.compiledAt.toISOString(),
      })),
      skipped,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
