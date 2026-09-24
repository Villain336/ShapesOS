// Marketr — R3 nurture sequence detail API.
// GET    /api/nurture/sequences/[id]            → detail + steps + enrollments
// PATCH  /api/nurture/sequences/[id] (editor+)  → update (name, steps, status…)
// DELETE /api/nurture/sequences/[id] (editor+)  → archive (soft delete)

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { nurtureCtx, requireNurtureEditor, readJson, sequenceStats } from "../../_lib";
import { parseSteps } from "@/lib/messaging/sequences";

export const dynamic = "force-dynamic";

const StepSchema = z.object({
  channel: z.enum(["sms", "email", "voice"]),
  delayMinutes: z.number().int().min(0).max(525600),
  template: z.string().trim().min(1).max(5000),
  subject: z.string().trim().max(300).optional(),
});

const PatchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  steps: z.array(StepSchema).max(25).optional(),
  status: z.enum(["draft", "active", "paused", "archived"]).optional(),
  dailyCap: z.number().int().min(1).max(100000).nullable().optional(),
  approvalPolicy: z.literal("manual").optional(),
});

async function findSequence(ctx: { workspaceId: string }, id: string) {
  return prisma.nurtureSequence.findFirst({
    where: { id, workspaceId: ctx.workspaceId },
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const { id } = await params;
  const sequence = await findSequence(ctx, id);
  if (!sequence) return Response.json({ error: "Sequence not found" }, { status: 404 });

  const [enrollments, stats] = await Promise.all([
    prisma.sequenceEnrollment.findMany({
      where: { workspaceId: ctx.workspaceId, sequenceId: id },
      include: { lead: { select: { id: true, name: true, email: true, phone: true, company: true } } },
      orderBy: { updatedAt: "desc" },
      take: 200,
    }),
    sequenceStats(prisma, ctx.workspaceId, id),
  ]);
  return Response.json({
    sequence: { ...sequence, steps: parseSteps(sequence.steps), stats },
    enrollments,
  });
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const editor = await requireNurtureEditor(ctx);
  if (editor) return editor;
  const { id } = await params;
  const sequence = await findSequence(ctx, id);
  if (!sequence) return Response.json({ error: "Sequence not found" }, { status: 404 });

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return parsedBody.res;
  const parsed = PatchSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  // Activating requires at least one step; archived sequences are immutable
  // (duplicate them instead of editing).
  if (sequence.status === "archived" && d.status !== "archived") {
    return Response.json({ error: "Archived sequences cannot be edited" }, { status: 400 });
  }
  const nextSteps = d.steps ?? parseSteps(sequence.steps);
  if (d.status === "active" && nextSteps.length === 0) {
    return Response.json({ error: "Cannot activate a sequence with no steps" }, { status: 400 });
  }

  const updated = await prisma.nurtureSequence.update({
    where: { id },
    data: {
      ...(d.name !== undefined ? { name: d.name } : {}),
      ...(d.description !== undefined ? { description: d.description } : {}),
      ...(d.steps !== undefined ? { steps: d.steps as unknown as Prisma.InputJsonValue } : {}),
      ...(d.status !== undefined ? { status: d.status } : {}),
      ...(d.dailyCap !== undefined ? { dailyCap: d.dailyCap } : {}),
      ...(d.approvalPolicy !== undefined ? { approvalPolicy: d.approvalPolicy } : {}),
    },
  });
  return Response.json({ sequence: { ...updated, steps: parseSteps(updated.steps) } });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const editor = await requireNurtureEditor(ctx);
  if (editor) return editor;
  const { id } = await params;
  const sequence = await findSequence(ctx, id);
  if (!sequence) return Response.json({ error: "Sequence not found" }, { status: 404 });

  // Soft delete → archived (keeps the message ledger and stats intact).
  const archived = await prisma.nurtureSequence.update({
    where: { id },
    data: { status: "archived" },
  });
  return Response.json({ sequence: { ...archived, steps: parseSteps(archived.steps) } });
}
