// Marketr — Legal/Compliance slice 3 API.
// GET    /api/legal/documents/[id] — one document with full version
//        history (newest first), plus the workspaceId for file downloads
//        through the existing /api/files/[fileId]?download=1 endpoint.
// PATCH  /api/legal/documents/[id] — tenant edits metadata (editor):
//        title, notes, docType, or the CURRENT version's expiryDate /
//        expirySource / issuer. History rows are immutable.
// DELETE /api/legal/documents/[id] — tenant removes a document and its
//        version history (editor). Uploaded files stay in /files/legal/ —
//        the files trash flow owns their cleanup.
// Every response carries the information-not-advice label.

import { guardWorkspace, httpErrorResponse, readJson } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { PrismaLegalStore } from "@/lib/legal/prisma-store";
import { LEGAL_DISCLAIMER, LegalError } from "@/lib/legal/types";
import type {
  LegalDocumentType,
  LegalExpirySource,
} from "@/lib/legal/documents";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await params;
    const store = new PrismaLegalStore(prisma);
    const document = await store.getDocument(workspace.id, id);
    if (!document) {
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: "Document not found." },
        { status: 404 },
      );
    }
    return Response.json({
      disclaimer: LEGAL_DISCLAIMER,
      workspaceId: workspace.id,
      document,
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const body = (await readJson(req)) as {
      title?: unknown;
      notes?: unknown;
      docType?: unknown;
      expiryDate?: unknown;
      expirySource?: unknown;
      issuer?: unknown;
    };
    const store = new PrismaLegalStore(prisma);
    const document = await store.updateDocument(workspace.id, id, {
      title: typeof body.title === "string" ? body.title : undefined,
      notes:
        body.notes === undefined
          ? undefined
          : typeof body.notes === "string"
            ? body.notes
            : null,
      docType: typeof body.docType === "string" ? (body.docType as LegalDocumentType) : undefined,
      expiryDate:
        body.expiryDate === undefined
          ? undefined
          : body.expiryDate === null
            ? null
            : typeof body.expiryDate === "string"
              ? body.expiryDate
              : undefined,
      expirySource:
        typeof body.expirySource === "string"
          ? (body.expirySource as LegalExpirySource)
          : undefined,
      issuer:
        body.issuer === undefined
          ? undefined
          : typeof body.issuer === "string"
            ? body.issuer
            : null,
    });
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, document });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_DOCUMENT" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await params;
    const store = new PrismaLegalStore(prisma);
    await store.deleteDocument(workspace.id, id);
    return Response.json({ disclaimer: LEGAL_DISCLAIMER, deleted: true });
  } catch (e) {
    if (e instanceof LegalError) {
      const status = e.code === "UNKNOWN_DOCUMENT" ? 404 : 400;
      return Response.json(
        { disclaimer: LEGAL_DISCLAIMER, error: e.message },
        { status },
      );
    }
    return httpErrorResponse(e);
  }
}
