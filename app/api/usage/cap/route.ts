// Marketr — spend cap management API (Phase C, W4).
// POST /api/usage/cap?workspaceId= { capCredits?, blockAtCap?, alertAtPct? }
// Writes: admin+. Disabling the block is the explicit auto-overage opt-in.

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { requireWorkspaceAccess, workspaceIdFrom } from "@/lib/route-utils";
import { setSpendCap, checkCap } from "@/lib/metering/service";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "admin");
  if ("error" in access) return access.error;

  let body: { capCredits?: number; blockAtCap?: boolean; alertAtPct?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    const cap = await setSpendCap(access.workspaceId, {
      ...(body.capCredits !== undefined ? { capCredits: body.capCredits } : {}),
      ...(body.blockAtCap !== undefined ? { blockAtCap: body.blockAtCap } : {}),
      ...(body.alertAtPct !== undefined ? { alertAtPct: body.alertAtPct } : {}),
    });
    // Audit the cap change (disabling the block = overage opt-in).
    await prisma.fileChangeLog.create({
      data: {
        workspaceId: access.workspaceId,
        projectId: null,
        filePath: "(workspace)",
        actor: "user",
        action: "spend_cap_updated",
        summary: `Spend cap updated by ${user.email}: cap=${cap.capCredits}, blockAtCap=${cap.blockAtCap}, alertAt=${cap.alertAtPct}%`,
        approvedBy: user.id,
      },
    });
    const status = await checkCap(access.workspaceId);
    return Response.json({ cap, status });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to update cap" }, { status: 400 });
  }
}
