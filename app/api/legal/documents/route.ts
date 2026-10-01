// Marketr — Legal/Compliance slice 3 API.
// GET  /api/legal/documents — the tenant's vault: documents with their
//        current version and computed expiry tier.
// POST /api/legal/documents — multipart upload (editor):
//        fields: documentId? (omit to create a new document; set to add a
//        version to an existing one), docType, title, notes?, expiryDate?,
//        expirySource? (tenant_set | read_from_document), issuer?, file.
//        Files go through the EXISTING filesystem pipeline (writeFile via
//        the legal store — same 25 MB cap, upload safety, quota as
//        POST /api/files) into /files/legal/<docType>/; the store registers
//        the metadata + version rows.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import type { LegalDocumentType, LegalExpirySource } from "@/lib/legal/documents";
import { FsError } from "@/lib/filesystem/service";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const store = new PrismaLegalStore(prisma);
    const documents = await store.listDocuments(workspace.id);
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      workspaceId: workspace.id,
      documents,
    });
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
      throw new LegalError("INVALID_UPLOAD", "Expected multipart form data.");
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new LegalError("MISSING_FILE", "Attach a file.");
    }
    if (file.size === 0) {
      throw new LegalError("EMPTY_FILE", "Attach a file — it cannot be empty.");
    }

    const documentId = formStr(form, "documentId");
    const expiryDate = formStr(form, "expiryDate");
    const expirySource = formStr(form, "expirySource");
    const issuer = formStr(form, "issuer");
    const bytes = Buffer.from(await file.arrayBuffer());

    const versionInput = {
      expiryDate: expiryDate === "" ? null : expiryDate,
      expirySource: (expirySource === "" ? null : expirySource) as LegalExpirySource | null,
      issuer: issuer === "" ? null : issuer,
      fileName: file.name,
      fileBytes: bytes,
      mimeType: file.type || undefined,
    };

    const store = new PrismaLegalStore(prisma);
    const document = documentId
      ? await store.addVersion(workspace.id, user.id, documentId, versionInput)
      : await store.createDocument(workspace.id, user.id, {
          // An empty docType fails store validation — the type is the
          // tenant's choice, never defaulted by the API.
          docType: formStr(form, "docType") as LegalDocumentType,
          title: formStr(form, "title"),
          notes: formStr(form, "notes") || null,
          ...versionInput,
        });
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, document }, { status: 201 });
  } catch (e) {
    if (e instanceof LegalError) {
      const status =
        e.code === "UNKNOWN_DOCUMENT"
          ? 404
          : e.code === "INVALID_DOC_TYPE" ||
            e.code === "INVALID_DATE" ||
            e.code === "INVALID_EXPIRY_SOURCE"
            ? 400
            : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    if (e instanceof FsError) {
      const status =
        e.code === "too_large" || e.code === "quota_exceeded"
          ? 413
          : e.code === "conflict"
            ? 409
            : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}
