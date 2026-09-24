// Marketr — CRM capture-form admin.
// PATCH  /api/crm/forms/[id]  → { name?, enabled?, fields? } (editor+)
// DELETE /api/crm/forms/[id]  → revoke (editor+)

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";

const FieldSchema = z.object({
  key: z.enum(["name", "email", "phone", "company", "title", "message"]),
  label: z.string().trim().min(1).max(60),
  required: z.boolean().default(false),
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  fields: z.array(FieldSchema).max(10).nullable().optional(),
}).refine((d) => Object.values(d).some((v) => v !== undefined), {
  message: "Nothing to update",
});

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;
  const form = await prisma.leadCaptureForm.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!form) return Response.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const updated = await prisma.leadCaptureForm.update({
    where: { id },
    data: {
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
      ...(parsed.data.fields !== undefined ? { fields: parsed.data.fields ?? undefined } : {}),
    },
  });
  return Response.json({ form: { id: updated.id, name: updated.name, enabled: updated.enabled } });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();
  const { id } = await ctx.params;
  const form = await prisma.leadCaptureForm.findFirst({ where: { id, workspaceId: workspace.id } });
  if (!form) return Response.json({ error: "Not found" }, { status: 404 });
  await prisma.leadCaptureForm.delete({ where: { id } });
  return Response.json({ deleted: id });
}
