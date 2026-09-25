// Marketr — POST /api/media/kill-rules/:id/toggle (owner-only)

import type { NextRequest } from "next/server";
import { z } from "zod";
import { mediaGuard, badRequest, safetyError, requireMediaOwner } from "../../../_lib";
import { mediaStores, safetyTablesReady, logMediaAudit } from "@/lib/media/db";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
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
    raw = {};
  }
  const parsed = z.object({ enabled: z.boolean() }).safeParse(raw);
  if (!parsed.success) return badRequest("Invalid input", parsed.error.issues);

  try {
    const { id } = await params;
    const { killRules, audit } = mediaStores();
    const rule = await killRules.setEnabled(id, gate.workspaceId, parsed.data.enabled);
    await logMediaAudit(audit, {
      workspaceId: gate.workspaceId, actor: gate.userId,
      action: "kill_rule_toggled", subjectType: "kill_rule", subjectId: rule.id,
      detail: { name: rule.name, enabled: rule.enabled },
    }).catch((e) => console.error("[media-audit] kill_rule_toggled write failed:", e));
    return Response.json({ rule });
  } catch (err) {
    return safetyError(err);
  }
}
