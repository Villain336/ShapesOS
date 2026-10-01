// Marketr — Wave 2 WFH mode slice 6: monthly expense summary.
// GET /api/wfh/expenses/summary?month=YYYY-MM — per-category totals plus the
// total deductible portion. A starting point for the user's accountant —
// this module never gives tax advice.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const month = req.nextUrl.searchParams.get("month");
  const now = new Date();
  const y = month && /^\d{4}-\d{2}$/.test(month) ? Number(month.slice(0, 4)) : now.getUTCFullYear();
  const m = month && /^\d{4}-\d{2}$/.test(month) ? Number(month.slice(5, 7)) : now.getUTCMonth() + 1;
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));

  const expenses = await prisma.wfhExpense.findMany({
    where: {
      workspaceId: workspace.id,
      userId: user.id,
      occurredOn: { gte: from, lt: to },
    },
    include: { category: true },
  });

  const byCategory = new Map<string, { key: string; name: string; totalCents: number; deductibleCents: number; count: number }>();
  for (const e of expenses) {
    const slot = byCategory.get(e.category.key) ?? {
      key: e.category.key,
      name: e.category.name,
      totalCents: 0,
      deductibleCents: 0,
      count: 0,
    };
    slot.totalCents += e.amountCents;
    slot.deductibleCents += e.deductibleCents;
    slot.count += 1;
    byCategory.set(e.category.key, slot);
  }

  const categories = [...byCategory.values()].sort((a, b) => b.deductibleCents - a.deductibleCents);
  return NextResponse.json({
    month: `${y}-${String(m).padStart(2, "0")}`,
    categories,
    totalCents: categories.reduce((s, c) => s + c.totalCents, 0),
    totalDeductibleCents: categories.reduce((s, c) => s + c.deductibleCents, 0),
    expenseCount: expenses.length,
  });
}
