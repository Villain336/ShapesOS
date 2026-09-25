// Marketr — /api/media/approvals
// POST → create a per-buy binding approval (draft; buyers propose, owners approve)
// GET  → list approvals (workspace-scoped)

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest, safetyError } from "../_lib";
import { CreateApprovalSchema } from "../_schemas";
import { mediaStores, safetyTablesReady } from "@/lib/media/db";
import { createApproval, type BuyBinding } from "@/lib/media/approvals";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await safetyTablesReady())) {
    return Response.json({ approvals: [], tablesReady: false });
  }
  const q = new URL(req.url).searchParams;
  const status = q.get("status")?.trim() as
    | "draft" | "pending" | "approved" | "executed" | "expired" | "revoked" | null;
  const { approvals } = mediaStores();
  const rows = await approvals.list(gate.workspaceId, status ?? undefined, 100);
  return Response.json({ approvals: rows, tablesReady: true });
}

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  if (!(await safetyTablesReady())) {
    return Response.json(
      { error: "Media safety tables not provisioned yet (fragment not merged/migrated)." },
      { status: 503 },
    );
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreateApprovalSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);
  const { clientId, type, binding, poolId } = parsed.data;

  try {
    const { approvals, pools } = mediaStores();
    if (poolId) {
      const pool = await pools.get(poolId, gate.workspaceId);
      if (!pool) return badRequest("Budget pool not found in workspace.");
      if (!pool.platformAllowlist.includes(binding.platform.toLowerCase())) {
        return badRequest(`Platform "${binding.platform}" is not allowlisted on pool ${pool.name}.`);
      }
    }
    const approval = await createApproval(approvals, {
      workspaceId: gate.workspaceId,
      clientId,
      type,
      binding: binding as BuyBinding,
      poolId,
      createdBy: gate.userId,
      createdByMediaRole: gate.mediaRole,
    });
    return Response.json({ approval }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
