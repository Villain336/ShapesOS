// Marketr — Revenue attribution (C2): manual spend entry.
//
// Ad APIs don't exist yet, so channel spend is entered manually. Spend rows
// are business data, not a billing meter: they feed CPL/CAC/ROAS math only.
// Every function is workspace-scoped; cross-workspace ids resolve to
// not-found, never to another workspace's rows.

import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BadRequestError } from "@/lib/api/errors";

/**
 * The spend fields without the cross-field rule. Use this for partial
 * (PATCH) parsing: zod 4 throws at runtime on `.partial()` of a refined
 * object, which turned every PATCH into a 500.
 */
export const SpendFieldsSchema = z.object({
  channel: z.string().trim().min(1).max(64).transform((s) => s.toLowerCase()),
  campaign: z.string().trim().max(160).optional(),
  amountCents: z.number().int().min(0).max(100_000_000_000),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  notes: z.string().trim().max(500).optional(),
});

export const SpendInputSchema = SpendFieldsSchema.refine(
  (d) => d.periodEnd.getTime() >= d.periodStart.getTime(),
  { message: "periodEnd must be >= periodStart" },
);

export type SpendInput = z.infer<typeof SpendInputSchema>;

export async function listSpend(
  workspaceId: string,
  filters: { channel?: string; from?: Date; to?: Date } = {},
) {
  const where: Prisma.AttributionSpendWhereInput = { workspaceId };
  if (filters.channel) where.channel = filters.channel;
  // Period overlap with the report window.
  if (filters.from || filters.to) {
    if (filters.to) where.periodStart = { lte: filters.to };
    if (filters.from) where.periodEnd = { gte: filters.from };
  }
  return prisma.attributionSpend.findMany({
    where,
    orderBy: [{ periodStart: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}

export async function createSpend(workspaceId: string, input: SpendInput) {
  return prisma.attributionSpend.create({
    data: {
      workspaceId,
      channel: input.channel,
      campaign: input.campaign?.trim() || null,
      amountCents: input.amountCents,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      notes: input.notes?.trim() || null,
    },
  });
}

export async function updateSpend(
  workspaceId: string,
  id: string,
  input: Partial<SpendInput>,
) {
  const existing = await prisma.attributionSpend.findFirst({ where: { id, workspaceId } });
  if (!existing) return null;
  // The period rule holds against the stored row too (a PATCH may send one end).
  const start = input.periodStart ?? existing.periodStart;
  const end = input.periodEnd ?? existing.periodEnd;
  if (end.getTime() < start.getTime()) {
    throw new BadRequestError("periodEnd must be >= periodStart");
  }
  return prisma.attributionSpend.update({
    where: { id },
    data: {
      ...(input.channel !== undefined ? { channel: input.channel } : {}),
      ...(input.campaign !== undefined ? { campaign: input.campaign?.trim() || null } : {}),
      ...(input.amountCents !== undefined ? { amountCents: input.amountCents } : {}),
      ...(input.periodStart !== undefined ? { periodStart: input.periodStart } : {}),
      ...(input.periodEnd !== undefined ? { periodEnd: input.periodEnd } : {}),
      ...(input.notes !== undefined ? { notes: input.notes?.trim() || null } : {}),
    },
  });
}

export async function deleteSpend(workspaceId: string, id: string): Promise<boolean> {
  const existing = await prisma.attributionSpend.findFirst({
    where: { id, workspaceId },
    select: { id: true },
  });
  if (!existing) return false;
  await prisma.attributionSpend.delete({ where: { id } });
  return true;
}
