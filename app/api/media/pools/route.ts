// Marketr — /api/media/pools
// POST → create a non-custodial budget pool (owner/admin only — sets the cap)
// GET  → list pools (workspace-scoped)
// A BudgetPool is an accounting object only: Marketr never holds, fronts, or
// co-mingles client money. The cap is human-approved; every buy inside it
// still needs a per-buy approval in v1.

import type { NextRequest } from "next/server";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../_lib";
import { CreatePoolSchema } from "../_schemas";
import { mediaStores, safetyTablesReady, logMediaAudit } from "@/lib/media/db";
import { createPool } from "@/lib/media/pools";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const gate = await mediaGuard("viewer");
  if (gate instanceof Response) return gate;
  if (!(await safetyTablesReady())) {
    return Response.json({ pools: [], tablesReady: false });
  }
  const q = new URL(req.url).searchParams;
  const clientId = q.get("clientId")?.trim() || undefined;
  const { pools } = mediaStores();
  const rows = await pools.list(gate.workspaceId, clientId);
  return Response.json({ pools: rows, tablesReady: true });
}

export async function POST(req: NextRequest) {
  const gate = await mediaGuard("editor");
  if (gate instanceof Response) return gate;
  const ownerCheck = requireMediaOwner(gate.mediaRole);
  if (ownerCheck) return ownerCheck;
  if (!(await safetyTablesReady())) {
    return Response.json({ error: "Media safety tables not provisioned yet." }, { status: 503 });
  }
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return badRequest("Invalid JSON");
  }
  const parsed = CreatePoolSchema.safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { pools, audit } = mediaStores();
    const pool = await createPool(pools, {
      workspaceId: gate.workspaceId,
      createdBy: gate.userId,
      ...parsed.data,
    });
    // Append-only audit: every pool creation is a money-adjacent event.
    await logMediaAudit(audit, {
      workspaceId: gate.workspaceId,
      actor: gate.userId,
      action: "pool_created",
      subjectType: "pool",
      subjectId: pool.id,
      detail: { capCents: pool.capCents, period: pool.period, currency: pool.currency, clientId: pool.clientId },
    }).catch((e) => console.error("[media-audit] pool_created write failed:", e));
    return Response.json({ pool }, { status: 201 });
  } catch (err) {
    return safetyError(err);
  }
}
