// Marketr — Documenso signing requests (Phase 12 "embeds", API-only).
// GET  /api/documenso/requests — list workspace signing requests.
// POST /api/documenso/requests — create from a template PDF (multipart):
//   fields: title, templateName?, signers (JSON: [{name,email}]), file (PDF).
//   Creates the Documenso document, adds signers, sends it, and stores a
//   local SigningRequest row tracking the remote status.
// POST /api/documenso/requests/[id]/refresh — re-read status from Documenso.
// NO embedded signing UI: that is the paid Enterprise feature. Signers use
// Documenso's own emailed signing link.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import {
  DocumensoApiError,
  addDocumensoSigners,
  createDocumensoDocument,
  documensoStatus,
  getDocumensoDocument,
  sendDocumensoDocument,
  type DocumensoSigner,
} from "@/lib/integrations/documenso";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";

const SignersSchema = z
  .array(
    z.object({
      name: z.string().min(1).max(200),
      email: z.string().email().max(320),
    }),
  )
  .min(1)
  .max(10);

const MAX_PDF_BYTES = 10 * 1024 * 1024;

function serialize(row: {
  id: string;
  title: string;
  templateName: string | null;
  documensoDocumentId: string | null;
  status: string;
  signers: unknown;
  createdAt: Date;
}) {
  return {
    id: row.id,
    title: row.title,
    templateName: row.templateName,
    documensoDocumentId: row.documensoDocumentId,
    status: row.status,
    signers: row.signers,
    createdAt: row.createdAt.toISOString(),
  };
}

async function handleGET() {
  try {
    const { workspace } = await guardWorkspace();
    const rows = await prisma.signingRequest.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
    });
    return Response.json({ requests: rows.map(serialize) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

async function handlePOST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    if (!documensoStatus().configured) {
      return Response.json(
        { error: "Documenso is not configured. Set DOCUMENSO_URL and DOCUMENSO_API_KEY on the host." },
        { status: 503 },
      );
    }

    const form = await req.formData();
    const title = String(form.get("title") ?? "").trim();
    const templateName = String(form.get("templateName") ?? "").trim() || null;
    const file = form.get("file");
    if (!title) return Response.json({ error: "Title is required." }, { status: 400 });
    if (!(file instanceof File)) {
      return Response.json({ error: "A template PDF file is required." }, { status: 400 });
    }
    if (file.size > MAX_PDF_BYTES) {
      return Response.json({ error: "PDF must be under 10MB." }, { status: 400 });
    }
    if (file.type && file.type !== "application/pdf") {
      return Response.json({ error: "File must be a PDF." }, { status: 400 });
    }

    let signersRaw: unknown = [];
    try {
      signersRaw = JSON.parse(String(form.get("signers") ?? "[]"));
    } catch {
      return Response.json({ error: "Signers must be valid JSON." }, { status: 400 });
    }
    const parsedSigners = SignersSchema.safeParse(signersRaw);
    if (!parsedSigners.success) {
      return Response.json(
        { error: "At least one signer with a valid name and email is required." },
        { status: 400 },
      );
    }
    const signers: DocumensoSigner[] = parsedSigners.data.map((s) => ({
      name: s.name,
      email: s.email,
      role: "SIGNER" as const,
    }));

    const pdfBytes = new Uint8Array(await file.arrayBuffer());

    // Create the local row first (draft) so a Documenso-side failure still
    // leaves an auditable trail.
    const row = await prisma.signingRequest.create({
      data: {
        workspaceId: workspace.id,
        title,
        templateName,
        status: "draft",
        signers: signers.map((s) => ({ name: s.name, email: s.email })),
        createdBy: user.id,
      },
    });

    try {
      const doc = await createDocumensoDocument(pdfBytes, file.name || "document.pdf", title);
      await addDocumensoSigners(doc.id, signers);
      await sendDocumensoDocument(doc.id);
      const updated = await prisma.signingRequest.update({
        where: { id: row.id },
        data: { documensoDocumentId: doc.id, status: doc.status },
      });
      return Response.json({ request: serialize(updated) }, { status: 201 });
    } catch (e) {
      const message =
        e instanceof DocumensoApiError ? e.message : "Documenso request failed.";
      await prisma.signingRequest.update({
        where: { id: row.id },
        data: { status: "error" },
      });
      return Response.json({ error: message }, { status: 502 });
    }
  } catch (e) {
    return httpErrorResponse(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const GET = sidecarScoped(handleGET);
export const POST = sidecarScoped(handlePOST);
