// Marketr — Wave 2 WFH mode slice 6: expenses API.
// GET /api/wfh/expenses — list the caller's expenses (?month=YYYY-MM).
// POST /api/wfh/expenses — record an expense; the allocation rule is taken
// from the category (snapshot at record time), so later rule changes never
// rewrite history.

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { getOrSeedExpenseCategories } from "@/lib/wfh/expense-store";
import { validateExpense, WfhExpenseError, type AllocationMethod } from "@/lib/wfh/expenses";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const month = req.nextUrl.searchParams.get("month");
  let from: Date | null = null;
  let to: Date | null = null;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split("-").map(Number);
    from = new Date(Date.UTC(y, m - 1, 1));
    to = new Date(Date.UTC(y, m, 1));
  }

  const expenses = await prisma.wfhExpense.findMany({
    where: {
      workspaceId: workspace.id,
      userId: user.id,
      ...(from && to ? { occurredOn: { gte: from, lt: to } } : {}),
    },
    include: { category: true },
    orderBy: { occurredOn: "desc" },
    take: 200,
  });
  return NextResponse.json({ expenses });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const categories = await getOrSeedExpenseCategories(workspace.id, user.id);
    const category = categories.find((c) => c.key === String(body.categoryKey ?? ""));
    if (!category) {
      throw new WfhExpenseError("UNKNOWN_CATEGORY", `Unknown category: ${body.categoryKey}`);
    }

    const v = validateExpense({
      categoryKey: category.key,
      // Raw values: validateExpense type-checks them (a numeric currency or
      // a fractional amount is a 422, never a 500 or a silent rounding).
      amountCents: body.amountCents,
      currency: body.currency ?? "USD",
      occurredOn: body.occurredOn != null ? (body.occurredOn as string) : new Date(),
      allocation: {
        method: category.allocationMethod as AllocationMethod,
        percent: category.allocationPct,
        officeSqft: category.officeSqft,
        totalSqft: category.totalSqft,
      },
      note: body.note != null ? String(body.note) : null,
      receiptUrl: body.receiptUrl != null ? String(body.receiptUrl) : null,
    });
    if (!v.ok || !v.normalized) {
      throw new WfhExpenseError("VALIDATION_FAILED", "Expense is invalid.", v.errors);
    }
    const n = v.normalized;
    const expense = await prisma.wfhExpense.create({
      data: {
        workspaceId: workspace.id,
        userId: user.id,
        categoryId: category.id,
        amountCents: n.amountCents,
        currency: n.currency,
        occurredOn: n.occurredOn,
        allocationMethod: n.allocationMethod,
        allocationPct: n.allocationPct,
        deductibleCents: n.deductibleCents,
        note: n.note,
        receiptUrl: n.receiptUrl,
      },
    });
    return NextResponse.json({ expense }, { status: 201 });
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
