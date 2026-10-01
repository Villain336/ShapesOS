// Marketr — E-sign module API.
// GET  /api/esign/envelopes — list workspace envelopes.
// POST /api/esign/envelopes — create a draft (multipart: title, signers JSON,
//   fields JSON?, signingOrder?, expiresAt?, templateId?, file PDF).
// Drafts are local-only: no vendor touch until the heavy-gated send.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import {
  createEnvelopeDraft,
  EsignGateError,
  type DraftFieldInput,
  type DraftSignerInput,
} from "@/lib/esign/envelopes";

export const dynamic = "force-dynamic";

const SignerSchema = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  role: z.enum(["signer", "approver", "cc"]).optional(),
  orderIndex: z.number().int().min(0).max(20).optional(),
});

const FieldSchema = z.object({
  signerEmail: z.string().email().max(320).optional(),
  fieldType: z.enum(["signature", "initials", "date", "text", "checkbox"]),
  page: z.number().int().min(1).max(500).optional(),
  x: z.number().min(0).max(2000).optional(),
  y: z.number().min(0).max(2000).optional(),
  width: z.number().min(10).max(2000).optional(),
  height: z.number().min(10).max(2000).optional(),
  required: z.boolean().optional(),
});

const MAX_PDF_BYTES = 10 * 1024 * 1024;

function serializeEnvelope(e: {
  id: string;
  title: string;
  status: string;
  signingOrder: string;
  vendorRef: string | null;
  documentName: string | null;
  expiresAt: Date | null;
  sealedPdfHash: string | null;
  sealedPdfFetchedAt: Date | null;
  voidReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  signers: Array<{ id: string; name: string; email: string; role: string; orderIndex: number; status: string; signedAt: Date | null }>;
}) {
  return {
    id: e.id,
    title: e.title,
    status: e.status,
    signingOrder: e.signingOrder,
    vendorRef: e.vendorRef,
    documentName: e.documentName,
    expiresAt: e.expiresAt?.toISOString() ?? null,
    sealedPdfHash: e.sealedPdfHash,
    sealedPdfFetchedAt: e.sealedPdfFetchedAt?.toISOString() ?? null,
    voidReason: e.voidReason,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
    signers: e.signers.map((s) => ({
      id: s.id,
      name: s.name,
      email: s.email,
      role: s.role,
      orderIndex: s.orderIndex,
      status: s.status,
      signedAt: s.signedAt?.toISOString() ?? null,
    })),
  };
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const rows = await prisma.esignEnvelope.findMany({
      where: { workspaceId: workspace.id },
      include: { signers: { orderBy: { orderIndex: "asc" } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return Response.json({ envelopes: rows.map(serializeEnvelope) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });

    const form = await req.formData();
    const title = String(form.get("title") ?? "").trim();
    const file = form.get("file");
    if (!title) return Response.json({ error: "Title is required." }, { status: 400 });
    if (!(file instanceof File)) {
      return Response.json({ error: "A PDF file is required." }, { status: 400 });
    }
    if (file.size === 0 || file.size > MAX_PDF_BYTES) {
      return Response.json({ error: "PDF must be non-empty and under 10MB." }, { status: 400 });
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
    const signersParsed = z.array(SignerSchema).min(1).max(20).safeParse(signersRaw);
    if (!signersParsed.success) {
      return Response.json({ error: "At least one signer with a valid name and email is required." }, { status: 400 });
    }

    let fieldsRaw: unknown = [];
    try {
      fieldsRaw = JSON.parse(String(form.get("fields") ?? "[]"));
    } catch {
      return Response.json({ error: "Fields must be valid JSON." }, { status: 400 });
    }
    const fieldsParsed = z.array(FieldSchema).max(100).safeParse(fieldsRaw);
    if (!fieldsParsed.success) {
      return Response.json({ error: "Fields are invalid." }, { status: 400 });
    }

    const signingOrder = String(form.get("signingOrder") ?? "sequential");
    if (!["sequential", "parallel"].includes(signingOrder)) {
      return Response.json({ error: "signingOrder must be sequential or parallel." }, { status: 400 });
    }
    const expiresRaw = String(form.get("expiresAt") ?? "").trim();
    const expiresAt = expiresRaw ? new Date(expiresRaw) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return Response.json({ error: "expiresAt is not a valid date." }, { status: 400 });
    }

    const pdfBytes = new Uint8Array(await file.arrayBuffer());
    const signers: DraftSignerInput[] = signersParsed.data.map((s) => ({
      name: s.name,
      email: s.email,
      role: s.role,
      orderIndex: s.orderIndex,
    }));
    const fields: DraftFieldInput[] = fieldsParsed.data.map((f) => ({ ...f }));

    const envelope = await createEnvelopeDraft(prisma, {
      workspaceId: workspace.id,
      title,
      signers,
      fields,
      signingOrder: signingOrder as "sequential" | "parallel",
      expiresAt,
      templateId: String(form.get("templateId") ?? "").trim() || null,
      documentName: file.name || "document.pdf",
      pdfBytes,
      createdBy: user.id,
    });

    const full = await prisma.esignEnvelope.findUnique({
      where: { id: envelope.id },
      include: { signers: { orderBy: { orderIndex: "asc" } } },
    });
    return Response.json({ envelope: serializeEnvelope(full!) }, { status: 201 });
  } catch (e) {
    if (e instanceof EsignGateError) {
      return Response.json({ error: e.message, code: e.code }, { status: 422 });
    }
    return httpErrorResponse(e);
  }
}
