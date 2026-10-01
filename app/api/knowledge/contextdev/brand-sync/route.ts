// Marketr — Wave 2 context.dev slice 5: brand-sync API.
// GET /api/knowledge/contextdev/brand-sync — list proposals (viewer).
// POST — fetch a brand profile and hold the diff for approval (editor).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import {
  proposeBrandSync,
  listBrandSyncs,
  BrandSyncError,
} from "@/lib/knowledge/contextdev/brandsync";

function toStatus(err: BrandSyncError): number {
  switch (err.code) {
    case "BUDGET_EXCEEDED":
      return 402;
    case "NO_KEY":
      return 424;
    case "BAD_DOMAIN":
    case "BAD_KIT":
      return 400;
    default:
      return 502;
  }
}

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const syncs = await listBrandSyncs(workspace.id);
  return NextResponse.json({ syncs });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { domain?: string; brandKitId?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (!body.domain?.trim()) {
    return NextResponse.json({ error: "domain is required" }, { status: 400 });
  }

  try {
    const sync = await proposeBrandSync(workspace.id, {
      domain: body.domain,
      brandKitId: body.brandKitId,
    });
    return NextResponse.json({ sync }, { status: 201 });
  } catch (err) {
    if (err instanceof BrandSyncError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: toStatus(err) });
    }
    throw err;
  }
}
