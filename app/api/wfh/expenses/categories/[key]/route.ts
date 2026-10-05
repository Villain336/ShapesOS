// Marketr — Wave 2 WFH mode slice 6: update a category's allocation rule.
// PATCH /api/wfh/expenses/categories/[key] — { method, percent } or
// { method: "square_footage", officeSqft, totalSqft }.
// Applies to NEW expenses; expenses already recorded keep the rule they were
// recorded with (the deduction is snapshotted at record time).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getOrSeedExpenseCategories } from "@/lib/wfh/expense-store";
import { validateAllocationRule, WfhExpenseError } from "@/lib/wfh/expenses";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ key: string }> },
) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { key } = await params;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    // Raw values: the validator parses them, so a blank percent ("") is
    // "missing" (400), never coerced to 0.
    const v = validateAllocationRule({
      method: body.method as string | undefined,
      percent: body.percent,
      officeSqft: body.officeSqft,
      totalSqft: body.totalSqft,
    });
    if (!v.ok || !v.normalized) {
      throw new WfhExpenseError("VALIDATION_FAILED", "Allocation rule is invalid.", v.errors);
    }
    await getOrSeedExpenseCategories(workspace.id, user.id);
    const category = await prisma.wfhExpenseCategory.findFirst({
      where: { workspaceId: workspace.id, userId: user.id, key },
    });
    if (!category) return NextResponse.json({ error: "Category not found" }, { status: 404 });

    const updated = await prisma.wfhExpenseCategory.update({
      where: { id: category.id },
      data: {
        allocationMethod: v.normalized.method,
        allocationPct: v.normalized.percent,
        officeSqft: v.normalized.officeSqft,
        totalSqft: v.normalized.totalSqft,
      },
    });
    return NextResponse.json({ category: updated });
  } catch (err) {
    if (err instanceof WfhExpenseError) {
      return NextResponse.json(
        { error: err.message, code: err.code, details: err.details },
        { status: 422 },
      );
    }
    throw err;
  }
}
