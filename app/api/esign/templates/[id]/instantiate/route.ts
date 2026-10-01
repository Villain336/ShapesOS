// Marketr — E-sign module API.
// POST /api/esign/templates/[id]/instantiate — mint a governed draft from a
// template. Body: { title?, mergeValues, signerBindings, expiresAt? }.
// Merge mismatches block with named reasons; the draft still needs the heavy
// send gate before anything goes out.

import { z } from "zod";
import { guardWorkspace, httpErrorResponse } from "@/lib/enrichment/guard";
import { prisma } from "@/lib/prisma";
import { EsignGateError, instantiateTemplate } from "@/lib/esign/templates";

export const dynamic = "force-dynamic";

const BodySchema = z.object({
  title: z.string().max(200).optional(),
  mergeValues: z.record(z.string(), z.unknown()).default({}),
  signerBindings: z
    .array(
      z.object({
        role: z.string().min(1).max(80),
        name: z.string().min(1).max(200),
        email: z.string().email().max(320),
      }),
    )
    .min(1)
    .max(20),
  expiresAt: z.string().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return Response.json({ error: "Instantiation input is invalid." }, { status: 400 });
    }
    const expiresAt = parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null;
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      return Response.json({ error: "expiresAt is not a valid date." }, { status: 400 });
    }

    const { envelope, resolvedMergeKeys } = await instantiateTemplate(prisma, {
      templateId: id,
      workspaceId: workspace.id,
      title: parsed.data.title,
      mergeValues: parsed.data.mergeValues,
      signerBindings: parsed.data.signerBindings,
      expiresAt,
      createdBy: user.id,
    });
    return Response.json(
      { envelope: { id: envelope.id, title: envelope.title, status: envelope.status }, resolvedMergeKeys },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof EsignGateError) {
      const status = e.code === "unknown_template" ? 404 : 422;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    return httpErrorResponse(e);
  }
}
