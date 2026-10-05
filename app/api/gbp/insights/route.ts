// Marketr — GBP insights API (milestone 16, flagged scaffold).
// GET /api/gbp/insights?accountId=…&locationId=…&days=… (viewer+)
// → insights (mock provider unless a live provider is configured).

import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import type { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { gbpGate } from "../_gate";
import { gbpProviderForWorkspace } from "@/lib/local/gbp-live";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = gbpGate();
  if (gate) return gate;
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId");
  const locationId = (sp.get("locationId") ?? "").trim();
  if (!accountId || !locationId) {
    return Response.json({ error: "accountId and locationId are required" }, { status: 400 });
  }
  const account = await prisma.gbpAccount.findFirst({ where: { id: accountId, workspaceId: workspace.id } });
  if (!account) return Response.json({ error: "Account not found" }, { status: 404 });

  const provider = await gbpProviderForWorkspace(workspace.id);
  const daysRaw = Number(sp.get("days") ?? 30);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, Math.round(daysRaw))) : 30;
  try {
    const insights = await provider.insights(locationId, days);
    return Response.json({ insights, provider: provider.name, mock: !provider.isLive });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Insights read failed." }, { status: 502 });
  }
}
