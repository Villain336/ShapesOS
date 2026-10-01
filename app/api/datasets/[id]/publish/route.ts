// Marketr — Dataset Builder slice 4 API.
// POST /api/datasets/[id]/publish — publish the latest compiled version
// to one or both targets.
//   JSON body: { targets?: ("briefnow" | "rag")[] } — defaults to both.
// Publishes are idempotent per (target, version): a repeated publish of
// the same version returns the existing record.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import {
  PUBLISH_TARGET_LABELS,
  publishDataset,
} from "@/lib/datasetbuilder/activate";
import {
  DatasetBuilderError,
  PUBLISH_TARGETS,
} from "@/lib/datasetbuilder/types";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  targets: z
    .array(z.enum(PUBLISH_TARGETS as [string, ...string[]]))
    .min(1)
    .default(["briefnow", "rag"]),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = BodySchema.parse(await req.json().catch(() => ({})));
    const store = new PrismaDatasetBuilderStore(prisma);

    const published = [];
    for (const target of body.targets) {
      try {
        const { record } = await publishDataset(store, {
          workspaceId: workspace.id,
          datasetId: id,
          target: target as (typeof PUBLISH_TARGETS)[number],
        });
        published.push({
          target,
          label: PUBLISH_TARGET_LABELS[record.target],
          version: record.version,
          chunkCount: record.chunkCount,
          artifactRef: record.artifactRef,
          publishedAt: record.publishedAt.toISOString(),
        });
      } catch (e) {
        if (e instanceof DatasetBuilderError) {
          if (e.code === "NO_VERSION_TO_PUBLISH") {
            return Response.json({ error: e.message }, { status: 422 });
          }
          if (e.code === "INVALID_PUBLISH_TARGET") {
            return Response.json({ error: e.message }, { status: 400 });
          }
          if (e.code === "UNKNOWN_DATASET") {
            return Response.json({ error: "Dataset not found" }, { status: 404 });
          }
        }
        throw e;
      }
    }
    return Response.json({ published });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
