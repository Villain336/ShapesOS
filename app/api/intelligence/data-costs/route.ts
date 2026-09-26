// Marketr — Phase 10 M6: data-costs API.
// GET /api/intelligence/data-costs?period=YYYY-MM → margin dashboard payload.
// (viewer+). The spend table, vendor routing config, and vendor health.

import type { NextRequest } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  getDataCostSummary,
  currentPeriod,
} from "@/lib/intelligence/providers/meter";
import {
  getVendorConfigs,
  vendorEnvVars,
} from "@/lib/intelligence/providers/credentials";
import { vendorHealth } from "@/lib/intelligence/providers/routing";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return Response.json({ error: "Forbidden" }, { status: 403 });

  const periodParam = req.nextUrl.searchParams.get("period");
  const period = /^\d{4}-\d{2}$/.test(periodParam ?? "") ? (periodParam as string) : currentPeriod();

  const [summary, configs, health] = await Promise.all([
    getDataCostSummary(workspace.id, period),
    getVendorConfigs(workspace.id),
    vendorHealth(workspace.id),
  ]);

  return Response.json({
    period,
    summary,
    configs,
    health,
    envVars: vendorEnvVars(),
    isAdmin: membership.role === "owner" || membership.role === "admin",
  });
}
