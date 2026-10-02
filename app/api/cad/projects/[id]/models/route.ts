// Marketr — CAD + Hardware slice 1 API.
// GET  /api/cad/projects/[id]/models — the project's models (viewer+).
// POST /api/cad/projects/[id]/models — multipart upload (editor):
//        fields: modelId? (set to publish a NEW version of an existing model;
//        omit to register a new model + its version 1 — history is never
//        overwritten), name? (required for new models), description?,
//        notes? (version notes), file (required).
//        The format is sniffed from the BYTES, never the filename. STEP
//        uploads store + version honestly (no preview claimed).

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaCadStore } from "@/lib/cad/prisma-store";
import { CadError } from "@/lib/cad/types";
import { FsError } from "@/lib/filesystem/service";

export const dynamic = "force-dynamic";

function cadErrorResponse(e: CadError) {
  const notFound = ["PROJECT_NOT_FOUND", "MODEL_NOT_FOUND", "VERSION_NOT_FOUND", "LINK_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

type Params = { params: Promise<{ id: string }> };

function formStr(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function GET(_req: Request, { params }: Params) {
  try {
    const { id } = await params;
    const { workspace } = await guardWorkspace();
    const store = new PrismaCadStore(prisma);
    const models = await store.listModels(workspace.id, id);
    return Response.json({ workspaceId: workspace.id, projectId: id, models });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request, { params }: Params) {
  try {
    const { id: projectId } = await params;
    const { user, workspace } = await guardWorkspace({ editor: true });
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart")) {
      throw new CadError("INVALID_UPLOAD", "Expected multipart form data.");
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new CadError("MISSING_FILE", "Attach a model file (STL, OBJ, or STEP).");
    }
    if (file.size === 0) {
      throw new CadError("EMPTY_FILE", "Attach a file — it cannot be empty.");
    }

    const store = new PrismaCadStore(prisma);
    const actor = user.email ?? user.id;
    const bytes = Buffer.from(await file.arrayBuffer());
    const modelId = formStr(form, "modelId");
    const notes = formStr(form, "notes") || null;

    if (modelId) {
      // Publish a new version of an existing model.
      const version = await store.addModelVersion(workspace.id, actor, modelId, {
        fileName: file.name,
        fileBytes: bytes,
        notes,
      });
      return Response.json({ version }, { status: 201 });
    }
    // Register a new model + its version 1.
    const name = formStr(form, "name");
    const { model, version } = await store.createModelWithVersion(
      workspace.id,
      actor,
      projectId,
      { name, description: formStr(form, "description") || null },
      { fileName: file.name, fileBytes: bytes, notes },
    );
    return Response.json({ model, version }, { status: 201 });
  } catch (e) {
    if (e instanceof CadError) return cadErrorResponse(e);
    if (e instanceof FsError) {
      const status =
        e.code === "too_large" || e.code === "quota_exceeded"
          ? 413
          : e.code === "conflict"
            ? 409
            : 400;
      return Response.json({ error: e.message }, { status });
    }
    return httpErrorResponse(e);
  }
}
