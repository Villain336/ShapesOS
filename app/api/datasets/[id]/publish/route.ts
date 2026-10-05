// Marketr — Dataset Builder slice 4 API.
// POST /api/datasets/[id]/publish — make a compiled version live on one or
// both targets.
//   JSON body: { targets?: ("briefnow" | "rag")[], version?: number }
//   targets default to both; version defaults to the latest compile. Passing
//   an older version is a rollback (Phase 4b): it becomes the live one.
// Publishing the version that is already live is a no-op (alreadyLive).
// BriefNow is a live pull over the ShapesOS MCP server
// (`get_dataset_adapter`), so the briefnow target needs the plan's API/MCP
// entitlement (403 + upgrade message otherwise). Emits `dataset.published`
// per go-live.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import {
  PUBLISH_TARGET_LABELS,
  publishDataset,
} from "@/lib/datasetbuilder/activate";
import {
  DatasetBuilderError,
  PUBLISH_TARGETS,
  type PublishTarget,
} from "@/lib/datasetbuilder/types";
import { requireEntitlement } from "@/lib/billing/entitlements-server";
import { emitDatasetPublished } from "@/lib/datasetbuilder/events";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  targets: z
    .array(z.enum(PUBLISH_TARGETS as [string, ...string[]]))
    .min(1)
    .default(["briefnow", "rag"]),
  version: z.number().int().positive().optional(),
});

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const raw = await readJson(req).catch(() => ({}));
    const body = BodySchema.parse(raw ?? {});
    if (body.targets.includes("briefnow")) {
      await requireEntitlement(workspace.id, "api_access");
    }
    const store = new PrismaDatasetBuilderStore(prisma);

    const published = [];
    for (const target of body.targets as PublishTarget[]) {
      try {
        const result = await publishDataset(store, {
          workspaceId: workspace.id,
          datasetId: id,
          target,
          version: body.version,
        });
        const { record } = result;
        if (!result.alreadyLive) {
          const dataset = await store.getDataset(id);
          if (dataset) {
            await emitDatasetPublished(workspace.id, dataset.type, record, {
              latestVersion: result.latestVersion,
              rollback: result.rollback,
            });
          }
        }
        published.push({
          target,
          label: PUBLISH_TARGET_LABELS[record.target],
          version: record.version,
          latestVersion: result.latestVersion,
          rollback: result.rollback,
          alreadyLive: result.alreadyLive,
          chunkCount: record.chunkCount,
          artifactRef: record.artifactRef,
          publishedAt: record.publishedAt.toISOString(),
        });
      } catch (e) {
        if (e instanceof DatasetBuilderError) {
          if (e.code === "NO_VERSION_TO_PUBLISH") {
            return Response.json({ error: e.message }, { status: 422 });
          }
          if (e.code === "INVALID_PUBLISH_TARGET" || e.code === "UNKNOWN_DATASET_VERSION") {
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
