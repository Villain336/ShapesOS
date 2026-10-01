// Marketr — Wave 2 WFH mode slice 6: expense categories API.
// GET /api/wfh/expenses/categories — the pre-wired pack (seeded on first
// call) with the user's allocation rules.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { getOrSeedExpenseCategories } from "@/lib/wfh/expense-store";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const categories = await getOrSeedExpenseCategories(workspace.id, user.id);
  return NextResponse.json({ categories });
}
