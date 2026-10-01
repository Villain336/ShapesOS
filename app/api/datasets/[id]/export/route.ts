// Marketr — Dataset Builder slice 3 API.
// GET /api/datasets/[id]/export?format=jsonl|parquet&version=N — download
// a compiled dataset version. version defaults to the latest.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import {
  exportDatasetJsonl,
  exportDatasetParquet,
  getVersionExportRows,
} from "@/lib/datasetbuilder/build";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaDatasetBuilderStore(prisma);

    const dataset = await store.getDataset(id);
    if (!dataset || dataset.workspaceId !== workspace.id) {
      return Response.json({ error: "Dataset not found" }, { status: 404 });
    }

    const url = new URL(req.url);
    const format = url.searchParams.get("format") ?? "jsonl";
    if (format !== "jsonl" && format !== "parquet") {
      return Response.json(
        { error: 'format must be "jsonl" or "parquet"' },
        { status: 400 },
      );
    }

    const versionParam = url.searchParams.get("version");
    let version = null;
    if (versionParam) {
      const n = Number.parseInt(versionParam, 10);
      const versions = await store.listDatasetVersions(id);
      version = versions.find((v) => v.version === n) ?? null;
    } else {
      version = await store.getLatestDatasetVersion(id);
    }
    if (!version) {
      return Response.json(
        { error: "No compiled versions for this dataset yet" },
        { status: 404 },
      );
    }

    const rows = await getVersionExportRows(store, version.id);
    const filename = `${dataset.type}-v${version.version}`;
    if (format === "parquet") {
      const buf = await exportDatasetParquet(rows);
      const bytes = new Uint8Array(buf);
      return new Response(bytes, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${filename}.parquet"`,
          "content-length": String(bytes.byteLength),
        },
      });
    }
    const jsonl = exportDatasetJsonl(rows);
    return new Response(jsonl, {
      headers: {
        "content-type": "application/jsonl",
        "content-disposition": `attachment; filename="${filename}.jsonl"`,
      },
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
