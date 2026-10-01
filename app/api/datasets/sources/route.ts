// Marketr — Dataset Builder slice 1 API.
// GET  /api/datasets/sources — source register (sources → documents → chunk counts).
// POST /api/datasets/sources — add a source. JSON body:
//   { kind: "paste", label, text } |
//   { kind: "web", url, label? } |
//   { kind: "drive", connectionId, fileId } |
//   multipart form: { kind: "upload", label?, file }
// Every ingest path writes through the same pipeline, so the zero-orphaned-
// chunks invariant holds identically for all four source kinds.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaDatasetBuilderStore } from "@/lib/datasetbuilder/prisma-store";
import {
  ingestDriveFile,
  ingestPaste,
  ingestUpload,
  ingestWeb,
} from "@/lib/datasetbuilder/ingest";
import { getSourceRegister } from "@/lib/datasetbuilder/register";
import {
  NangoCloudDriveAdapter,
  nangoCloudConfigFromEnv,
} from "@/lib/datasetbuilder/nango";
import { DatasetBuilderError } from "@/lib/datasetbuilder/types";

export const dynamic = "force-dynamic";

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const PasteSchema = z.object({
  kind: z.literal("paste"),
  label: z.string().min(1).max(200),
  text: z.string().min(1).max(500_000),
});

const WebSchema = z.object({
  kind: z.literal("web"),
  url: z.string().url().max(2000),
  label: z.string().max(200).optional(),
});

const DriveSchema = z.object({
  kind: z.literal("drive"),
  connectionId: z.string().min(1).max(200),
  fileId: z.string().min(1).max(500),
});

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaDatasetBuilderStore(prisma);
    const register = await getSourceRegister(store, workspace.id);
    return Response.json({
      workspaceId: register.workspaceId,
      totals: register.totals,
      sources: register.entries.map((e) => ({
        id: e.source.id,
        kind: e.source.kind,
        name: e.source.name,
        externalRef: e.source.externalRef ?? null,
        createdAt: e.source.createdAt.toISOString(),
        documentCount: e.documentCount,
        chunkCount: e.chunkCount,
        charCount: e.charCount,
        documents: e.documents.map((d) => ({
          id: d.document.id,
          name: d.document.name,
          mimeType: d.document.mimeType,
          status: d.document.status,
          error: d.document.error,
          chunkCount: d.chunkCount,
          charCount: d.charCount,
          createdAt: d.document.createdAt.toISOString(),
        })),
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const store = new PrismaDatasetBuilderStore(prisma);
    const contentType = req.headers.get("content-type") ?? "";

    if (contentType.includes("multipart/form-data")) {
      // Upload path: { kind: "upload", label?, file }.
      const form = await req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) {
        throw new DatasetBuilderError("VALIDATION_FAILED", "upload needs a file");
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        throw new DatasetBuilderError(
          "VALIDATION_FAILED",
          `file exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024} MB upload limit`,
        );
      }
      const label = form.get("label");
      const result = await ingestUpload(store, {
        workspaceId: workspace.id,
        filename: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
        label: typeof label === "string" && label.trim() ? label : undefined,
      });
      return Response.json(serializeResult(result), { status: 201 });
    }

    const body = await req.json();
    if (body?.kind === "paste") {
      const input = PasteSchema.parse(body);
      const result = await ingestPaste(store, {
        workspaceId: workspace.id,
        label: input.label,
        text: input.text,
      });
      return Response.json(serializeResult(result), { status: 201 });
    }
    if (body?.kind === "web") {
      const input = WebSchema.parse(body);
      const result = await ingestWeb(store, {
        workspaceId: workspace.id,
        url: input.url,
        label: input.label,
      });
      return Response.json(serializeResult(result), { status: 201 });
    }
    if (body?.kind === "drive") {
      const input = DriveSchema.parse(body);
      const config = nangoCloudConfigFromEnv(input.connectionId);
      const adapter = new NangoCloudDriveAdapter(config);
      const result = await ingestDriveFile(store, {
        workspaceId: workspace.id,
        connectionId: input.connectionId,
        fileId: input.fileId,
        adapter,
      });
      return Response.json(serializeResult(result), { status: 201 });
    }
    throw new DatasetBuilderError(
      "VALIDATION_FAILED",
      'kind must be "paste", "web", "drive", or multipart "upload"',
    );
  } catch (e) {
    return httpErrorResponse(e);
  }
}

function serializeResult(result: {
  source: { id: string; kind: string; name: string };
  document: { id: string; name: string; status: string };
  chunkCount: number;
  charCount: number;
}) {
  return {
    sourceId: result.source.id,
    sourceKind: result.source.kind,
    sourceName: result.source.name,
    documentId: result.document.id,
    documentName: result.document.name,
    documentStatus: result.document.status,
    chunkCount: result.chunkCount,
    charCount: result.charCount,
  };
}
