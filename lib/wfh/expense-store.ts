// Marketr — Wave 2 WFH mode slice 6: expense category store helper.
// Seeds the pre-wired category pack on first use, per user.

import { prisma } from "@/lib/prisma";
import { EXPENSE_CATEGORY_PRESETS } from "./expenses";

export async function getOrSeedExpenseCategories(workspaceId: string, userId: string) {
  const existing = await prisma.wfhExpenseCategory.findMany({
    where: { workspaceId, userId },
  });
  if (existing.length > 0) return existing;

  await prisma.wfhExpenseCategory.createMany({
    data: EXPENSE_CATEGORY_PRESETS.map((p) => ({
      workspaceId,
      userId,
      key: p.key,
      name: p.name,
      description: p.description,
      allocationMethod: p.defaultMethod,
      allocationPct: p.defaultAllocationPct,
    })),
  });
  return prisma.wfhExpenseCategory.findMany({ where: { workspaceId, userId } });
}
