// ShapesOS Phase 10 (ops-core): POST /api/ops/crm/convert-lead
//   { leadId, createDeal?: boolean }
// Converts a capture lead into a Contact (+ Company by domain/name, + Deal
// on the lead's pipeline stage when asked). Idempotent and deduping
// (lib/ops/crm.ts convertLead). Editor+; RLS-scoped; audited.

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import { convertLead } from "@/lib/ops/crm";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";
import { validateBody, z } from "@/lib/api/validate";

export const dynamic = "force-dynamic";

const Body = z.object({ leadId: z.string().min(1).max(64), createDeal: z.boolean().optional() });

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const parsed = validateBody(Body, await req.json().catch(() => null));
    if (!parsed.ok) return parsed.error;
    const actor = { workspaceId: workspace.id, userId: user.id };
    const result = await withWorkspaceScope(workspace.id, (tx) =>
      convertLead(tx, actor, parsed.data.leadId, { createDeal: parsed.data.createDeal }),
    );
    return Response.json(result);
  } catch (err) {
    if (err instanceof OpsError) return Response.json({ error: err.message }, { status: err.status });
    return errorResponse(err);
  }
}
