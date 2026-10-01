// Marketr — Phase 18 slice 3: connect an API-key ad platform.
// POST /api/ads/apikey/connect { platformKey, apiKey, label? } → { ok, accountId }
// Slice 3 covers stackadapt only; every other key is fail-closed: spotify is
// guided-only (no credential to store); walmart is guided-only too (slice 4,
// outcome B — partner-level auth, no advertiser OAuth).

import { NextRequest, NextResponse } from "next/server";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { connectStackAdaptKey } from "@/lib/adplatforms/stackadapt/connect";
import { StackAdaptError } from "@/lib/adplatforms/stackadapt/client";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let body: { platformKey?: string; apiKey?: string; label?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (body.platformKey !== "stackadapt") {
    return NextResponse.json(
      { error: `API-key connect is not supported for "${body.platformKey ?? "unknown"}" — stackadapt only` },
      { status: 400 },
    );
  }

  try {
    const result = await connectStackAdaptKey({
      userId: user.id,
      workspaceId: workspace.id,
      apiKey: body.apiKey ?? "",
      label: body.label,
    });
    return NextResponse.json({
      ok: true,
      accountId: result.accountId,
      advertiserName: result.advertiserName,
    });
  } catch (e) {
    if (e instanceof StackAdaptError) {
      // AUTH_FAILED (bad key) and INVALID_KEY both surface as 400 with the
      // platform message — never the key itself.
      const status = e.code === "AUTH_FAILED" ? 401 : 400;
      return NextResponse.json({ error: e.message, code: e.code }, { status });
    }
    return NextResponse.json({ error: "Could not connect the StackAdapt key" }, { status: 500 });
  }
}
