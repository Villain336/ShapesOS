// Marketr — /api/substrate shared guard (not a route: no HTTP exports).
//
// Phase 8 substrate namespace (SPEC-PHASE8.md §5). Session → workspace;
// reads need viewer, mutations need editor. Mirrors
// app/api/flywheel/_lib.ts conventions.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, getMembership, forbidden } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { CampaignError } from "@/lib/substrate/campaigns/types";
import { errorResponse } from "@/lib/api/errors";

export interface SubstrateGuard {
  userId: string;
  workspaceId: string;
  role: string;
}

/** Session guard. Mutations pass "editor"; reads pass "viewer". */
export async function substrateGuard(
  min: "viewer" | "editor" = "viewer",
): Promise<SubstrateGuard | Response> {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (min === "editor" && !(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return forbidden();
  }
  const membership = await getMembership(user.id, workspace.id);
  return { userId: user.id, workspaceId: workspace.id, role: membership?.role ?? "viewer" };
}

export function badRequest(message: string, issues?: unknown) {
  return Response.json({ error: message, ...(issues ? { issues } : {}) }, { status: 400 });
}

export function tablesNotReady() {
  return Response.json(
    {
      error:
        "Campaign object tables are not provisioned on this database. Run `prisma migrate deploy` (migration 20260925180000_phase8_campaign_object).",
    },
    { status: 503 },
  );
}

let _ready: boolean | null = null;
/** The three G2 tables exist? Cached per process (migrations change this). */
export async function campaignTablesReady(): Promise<boolean> {
  if (_ready !== null) return _ready;
  try {
    const rows = (await prisma.$queryRaw`
      SELECT count(*)::int AS n FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('growth_campaigns', 'campaign_links', 'campaign_link_proposals')
    `) as Array<{ n: number }>;
    _ready = rows[0]?.n === 3;
  } catch {
    _ready = false;
  }
  return _ready;
}

/** Map engine CampaignError codes to HTTP. */
export function campaignError(err: unknown) {
  if (err instanceof CampaignError) {
    const status =
      err.code === "not_found" || err.code === "fragment_missing" ? 404
      : err.code === "duplicate_link" ? 409
      : 422;
    return Response.json({ error: err.message, code: err.code }, { status });
  }
  return errorResponse(err);
}

/** Parse a JSON request body (empty/invalid -> {}). */
export async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const text = await req.text();
    if (!text.trim()) return {};
    return (JSON.parse(text) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}
