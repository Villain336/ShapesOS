// Marketr — R6 single prospect API.
// PATCH  /api/prospects/[id] (editor) → update fields / status / score
// DELETE /api/prospects/[id] (editor) → delete prospect

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { guardWorkspace, httpErrorResponse, readJson, HttpError } from "@/lib/enrichment/guard";

const PatchSchema = z.object({
  company: z.string().trim().max(200).nullable().optional(),
  name: z.string().trim().max(200).nullable().optional(),
  email: z.string().trim().max(200).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  title: z.string().trim().max(200).nullable().optional(),
  website: z.string().trim().max(500).nullable().optional(),
  status: z.enum(["new", "enriching", "enriched", "failed", "in_sequence", "converted"]).optional(),
  score: z.number().int().min(0).max(100).optional(),
});

async function getProspect(workspaceId: string, id: string) {
  const prospect = await prisma.prospect.findFirst({
    where: { id, workspaceId },
    include: { lookups: { orderBy: { createdAt: "desc" } } },
  });
  if (!prospect) throw new HttpError(404, "Prospect not found");
  return prospect;
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace();
    const { id } = await ctx.params;
    return Response.json({ prospect: await getProspect(workspace.id, id) });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    await getProspect(workspace.id, id);
    const parsed = PatchSchema.safeParse(await readJson(req));
    if (!parsed.success) {
      return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
    }
    const prospect = await prisma.prospect.update({ where: { id }, data: parsed.data });
    return Response.json({ prospect });
  } catch (e) {
    return httpErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { workspace } = await guardWorkspace({ editor: true });
    const { id } = await ctx.params;
    await getProspect(workspace.id, id);
    await prisma.prospect.delete({ where: { id } });
    return Response.json({ ok: true });
  } catch (e) {
    return httpErrorResponse(e);
  }
}
