// Marketr — CRM capture-form management.
// GET  /api/crm/forms?pipelineId=  → forms (token hashes never leave the server)
// POST /api/crm/forms  → { pipelineId, name, fields? } (editor+)
//        Returns the public token ONCE — store it in the embed snippet.

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { hashFormToken, newFormToken } from "@/lib/crm/dedup";

const FieldSchema = z.object({
  key: z.enum(["name", "email", "phone", "company", "title", "message"]),
  label: z.string().trim().min(1).max(60),
  required: z.boolean().default(false),
});

const CreateSchema = z.object({
  pipelineId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(120),
  fields: z.array(FieldSchema).max(10).optional(),
});

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const pipelineId = new URL(req.url).searchParams.get("pipelineId");
  const forms = await prisma.leadCaptureForm.findMany({
    where: { workspaceId: workspace.id, ...(pipelineId ? { pipelineId } : {}) },
    orderBy: { createdAt: "desc" },
    include: { pipeline: { select: { id: true, name: true } } },
  });
  return Response.json({
    forms: forms.map((f) => ({
      id: f.id, name: f.name, enabled: f.enabled,
      tokenPrefix: f.tokenPrefix, fields: f.fields,
      pipeline: f.pipeline, createdAt: f.createdAt,
    })),
  });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = CreateSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const pipeline = await prisma.pipeline.findFirst({
    where: { id: parsed.data.pipelineId, workspaceId: workspace.id },
  });
  if (!pipeline) return Response.json({ error: "Pipeline not found" }, { status: 404 });

  const { token, prefix } = newFormToken();
  const form = await prisma.leadCaptureForm.create({
    data: {
      workspaceId: workspace.id,
      pipelineId: pipeline.id,
      name: parsed.data.name,
      tokenHash: hashFormToken(token),
      tokenPrefix: prefix,
      fields: parsed.data.fields ?? undefined,
    },
  });
  // The token is returned once. It is never stored server-side (hash only).
  return Response.json({ form: { id: form.id, name: form.name, tokenPrefix: prefix }, token }, { status: 201 });
}
