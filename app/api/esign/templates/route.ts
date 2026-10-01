// Marketr — E-sign module API.
// GET  /api/esign/templates — list workspace templates.
// POST /api/esign/templates — create a template (multipart: name, file PDF,
//   signerRoles JSON, fieldLayout JSON, mergeFieldMapping JSON).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import {
  createTemplate,
  EsignGateError,
  type MergeFieldDef,
  type SignerRoleDef,
  type TemplateFieldDef,
} from "@/lib/esign/templates";

export const dynamic = "force-dynamic";

const RoleSchema = z.object({
  role: z.string().min(1).max(80),
  orderIndex: z.number().int().min(0).max(20).optional().default(0),
  required: z.boolean().optional().default(true),
});

const FieldSchema = z.object({
  signerRole: z.string().min(1).max(80),
  fieldType: z.enum(["signature", "initials", "date", "text", "checkbox"]),
  page: z.number().int().min(1).max(500).optional(),
  x: z.number().min(0).max(2000).optional(),
  y: z.number().min(0).max(2000).optional(),
  width: z.number().min(10).max(2000).optional(),
  height: z.number().min(10).max(2000).optional(),
  required: z.boolean().optional(),
});

const MergeDefSchema = z.object({
  source: z.string().min(1).max(80),
  path: z.string().min(1).max(200),
  required: z.boolean().optional().default(false),
});

const MAX_PDF_BYTES = 10 * 1024 * 1024;

function parseJsonField(raw: FormDataEntryValue | null, label: string): unknown {
  if (raw == null || raw === "") return label === "mergeFieldMapping" ? {} : [];
  try {
    return JSON.parse(String(raw));
  } catch {
    throw new EsignGateError("bad_json", `${label} must be valid JSON.`);
  }
}

export async function GET() {
  try {
    const { workspace } = await guardWorkspace();
    const rows = await prisma.esignTemplate.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return Response.json({
      templates: rows.map((t) => ({
        id: t.id,
        name: t.name,
        sourceDocumentName: t.sourceDocumentName,
        sourceDocumentHash: t.sourceDocumentHash,
        signerRoles: t.signerRoles,
        fieldLayout: t.fieldLayout,
        mergeFieldMapping: t.mergeFieldMapping,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        contractType: t.contractType ?? null,
      })),
    });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const form = await req.formData();
    const name = String(form.get("name") ?? "").trim();
    const file = form.get("file");
    if (!name) return Response.json({ error: "Name is required." }, { status: 400 });
    if (!(file instanceof File) || file.size === 0 || file.size > MAX_PDF_BYTES) {
      return Response.json({ error: "A non-empty PDF under 10MB is required." }, { status: 400 });
    }

    const signerRoles = z.array(RoleSchema).min(1).max(20).parse(parseJsonField(form.get("signerRoles"), "signerRoles"));
    const fieldLayout = z.array(FieldSchema).max(100).parse(parseJsonField(form.get("fieldLayout"), "fieldLayout"));
    const mergeFieldMapping = z.record(z.string(), MergeDefSchema).parse(parseJsonField(form.get("mergeFieldMapping"), "mergeFieldMapping"));

    const template = await createTemplate(prisma, {
      workspaceId: workspace.id,
      name,
      pdfBytes: new Uint8Array(await file.arrayBuffer()),
      documentName: file.name || "template.pdf",
      signerRoles: signerRoles as SignerRoleDef[],
      fieldLayout: fieldLayout as TemplateFieldDef[],
      mergeFieldMapping: mergeFieldMapping as Record<string, MergeFieldDef>,
      createdBy: user.id,
    });
    return Response.json({ template: { id: template.id, name: template.name } }, { status: 201 });
  } catch (e) {
    if (e instanceof EsignGateError) {
      return Response.json({ error: e.message, code: e.code }, { status: 422 });
    }
    if (e instanceof z.ZodError) {
      return Response.json({ error: "Template definition is invalid." }, { status: 400 });
    }
    return httpErrorResponse(e);
  }
}
