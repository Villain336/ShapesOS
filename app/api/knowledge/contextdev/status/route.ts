// Marketr — Wave 2 context.dev slice 1: status API.
// GET /api/knowledge/contextdev/status — connection state + today's budget.
// Never exposes the key.

import { NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { resolveContextDevKey, ContextDevKeyError } from "@/lib/knowledge/contextdev/keys";
import { getDailyBudget } from "@/lib/knowledge/contextdev/budget-store";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let connected = false;
  try {
    await resolveContextDevKey(workspace.id);
    connected = true;
  } catch (err) {
    if (!(err instanceof ContextDevKeyError)) throw err;
    connected = false;
  }

  const budget = await getDailyBudget(workspace.id);
  return NextResponse.json({
    connected,
    budget: {
      day: budget.day,
      usedToday: budget.usedToday,
      capCredits: budget.capCredits,
      remaining: Math.max(0, budget.capCredits - budget.usedToday),
    },
  });
}
