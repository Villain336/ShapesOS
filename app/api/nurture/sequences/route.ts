// Marketr — R3 nurture sequences API.
// GET  /api/nurture/sequences           → list (workspace-scoped, with stats)
// POST /api/nurture/sequences (editor+)  → create

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { nurtureCtx, requireNurtureEditor, readJson, sequenceStats } from "../_lib";
import { parseSteps } from "@/lib/messaging/sequences";

export const dynamic = "force-dynamic";

/** Sequence lifecycle states, from the Prisma enum-equivalent union. */
export const SEQUENCE_STATUSES = ["draft", "active", "paused", "archived"] as const;

const StepSchema = z.object({
  channel: z.enum(["sms", "email", "voice"]),
  delayMinutes: z.number().int().min(0).max(525600),
  template: z.string().trim().min(1).max(5000),
  subject: z.string().trim().max(300).optional(),
});

const CreateSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).optional(),
  steps: z.array(StepSchema).max(25).default([]),
  status: z.enum(SEQUENCE_STATUSES).default("draft"),
  approvalPolicy: z.literal("manual").default("manual"),
  dailyCap: z.number().int().min(1).max(100000).nullable().optional(),
});

export async function GET() {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;

  const sequences = await prisma.nurtureSequence.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { updatedAt: "desc" },
  });
  const withStats = await Promise.all(
    sequences.map(async (s) => ({
      ...s,
      steps: parseSteps(s.steps),
      stats: await sequenceStats(prisma, ctx.workspaceId, s.id),
    })),
  );
  return Response.json({ sequences: withStats, workspaceId: ctx.workspaceId });
}

export async function POST(req: Request) {
  const ctx = await nurtureCtx();
  if (ctx instanceof Response) return ctx;
  const editor = await requireNurtureEditor(ctx);
  if (editor) return editor;

  const parsedBody = await readJson(req);
  if (!parsedBody.ok) return parsedBody.res;
  const parsed = CreateSchema.safeParse(parsedBody.body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  const sequence = await prisma.nurtureSequence.create({
    data: {
      workspaceId: ctx.workspaceId,
      name: d.name,
      description: d.description ?? null,
      steps: d.steps as unknown as Prisma.InputJsonValue,
      status: d.status,
      approvalPolicy: d.approvalPolicy,
      dailyCap: d.dailyCap ?? null,
      createdBy: ctx.userId,
    },
  });
  return Response.json(
    { sequence: { ...sequence, steps: parseSteps(sequence.steps) } },
    { status: 201 },
  );
}
