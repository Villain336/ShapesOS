// Marketr — E-sign module API.
// GET    /api/esign/templates/[id] — template detail.
// PATCH  /api/esign/templates/[id] — update blueprint definition (JSON).
// DELETE /api/esign/templates/[id] — delete a template (envelopes keep their copy).

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { deleteTemplate, EsignGateError, updateTemplate } from "@/lib/esign/templates";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  contractType: z.string().max(80).nullable().optional(),
  signerRoles: z
    .array(z.object({ role: z.string().min(1).max(80), orderIndex: z.number().int().min(0).max(20).default(0), required: z.boolean().default(true) }))
    .min(1)
    .max(20)
    .optional(),
  fieldLayout: z
    .array(
      z.object({
        signerRole: z.string().min(1).max(80),
        fieldType: z.enum(["signature", "initials", "date", "text", "checkbox"]),
        page: z.number().int().min(1).max(500).optional(),
        x: z.number().min(0).max(2000).optional(),
        y: z.number().min(0).max(2000).optional(),
        width: z.number().min(10).max(2000).optional(),
        height: z.number().min(10).max(2000).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(100)
    .optional(),
  mergeFieldMapping: z
    .record(z.string(), z.object({ source: z.string().min(1).max(80), path: z.string().min(1).max(200), required: z.boolean().default(false) }))
    .optional(),
});

function serialize(t: {
  id: string;
  name: string;
  sourceDocumentName: string | null;
  sourceDocumentHash: string | null;
  sourceDocumentSize: number | null;
  signerRoles: unknown;
  fieldLayout: unknown;
  mergeFieldMapping: unknown;
  contractType: string | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: t.id,
    name: t.name,
    sourceDocumentName: t.sourceDocumentName,
    sourceDocumentHash: t.sourceDocumentHash,
    sourceDocumentSize: t.sourceDocumentSize,
    signerRoles: t.signerRoles,
    fieldLayout: t.fieldLayout,
    mergeFieldMapping: t.mergeFieldMapping,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    contractType: t.contractType ?? null,
  };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    const t = await prisma.esignTemplate.findFirst({ where: { id, workspaceId: workspace.id } });
    if (!t) return Response.json({ error: "Template not found." }, { status: 404 });
    return Response.json({ template: serialize(t) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const parsed = PatchSchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "Template definition is invalid." }, { status: 400 });
    const updated = await updateTemplate(prisma, {
      templateId: id,
      workspaceId: workspace.id,
      ...parsed.data,
    });
    return Response.json({ template: serialize(updated) });
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_template" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    await deleteTemplate(prisma, id, workspace.id);
    return Response.json({ ok: true });
  } catch (e) {
    if (e instanceof EsignGateError) {
      return Response.json({ error: e.message, code: e.code }, { status: 404 });
    }
    return httpErrorResponse(e);
  }
}
