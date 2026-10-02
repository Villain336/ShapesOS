// Marketr — Funding/VC slice 3 API.
// GET  /api/funding/data-room — the tenant's docs (current version +
//        counts; docType = kind: pitch_deck / financials / metrics / other).
// POST /api/funding/data-room — multipart upload (editor):
//        fields: documentId? (omit to create a new document; set to add a
//        NEW version to an existing one — history is never overwritten),
//        kind, title, notes?, file.
//        Files go through the EXISTING filesystem pipeline (writeFile — same
//        25 MB cap, upload safety, quota as POST /api/files) into
//        /files/funding/<kind>/ with a version-distinct filename.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaFundingStore } from "@/lib/funding/prisma-store";
import { FundingError } from "@/lib/funding/types";
import { FsError } from "@/lib/filesystem/service";
import type { DataRoomDocKind } from "@/lib/funding/dataroom";

export const dynamic = "force-dynamic";

function fundingErrorResponse(e: FundingError) {
  const notFound = ["DOC_NOT_FOUND", "LINK_NOT_FOUND", "VIEW_NOT_FOUND", "VERSION_NOT_FOUND"];
  return Response.json(
    { error: e.message, code: e.code },
    { status: notFound.includes(e.code) ? 404 : 400 },
  );
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaFundingStore(prisma);
    const documents = await store.listDocs(workspace.id);
    return Response.json({ workspaceId: workspace.id, documents });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

function formStr(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const contentType = req.headers.get("content-type") ?? "";
    if (!contentType.includes("multipart")) {
      throw new FundingError("INVALID_UPLOAD", "Expected multipart form data.");
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new FundingError("MISSING_FILE", "Attach a file.");
    }
    if (file.size === 0) {
      throw new FundingError("EMPTY_FILE", "Attach a file — it cannot be empty.");
    }

    const documentId = formStr(form, "documentId");
    const bytes = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || undefined;

    const store = new PrismaFundingStore(prisma);
    const actor = user.email ?? user.id;
    const document = documentId
      ? await store.addDocVersion(workspace.id, actor, documentId, {
          fileName: file.name,
          fileBytes: bytes,
          mimeType,
        })
      : await store.createDoc(workspace.id, actor, {
          // An empty kind fails store validation — the type is the
          // tenant's choice, never defaulted by the API.
          kind: formStr(form, "kind") as DataRoomDocKind,
          title: formStr(form, "title"),
          notes: formStr(form, "notes") || null,
          fileName: file.name,
          fileBytes: bytes,
          mimeType,
        });
    return Response.json({ document }, { status: 201 });
  } catch (e) {
    if (e instanceof FundingError) return fundingErrorResponse(e);
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
