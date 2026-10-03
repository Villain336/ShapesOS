// Marketr — Phase 17 slice 2: POST /api/ops/invoices/[id]/remind.
// Payment reminders are gated money comms (OPS_INVOICE_REMIND, medium).
//   { text }              → 202 { approval_required: true, approval }
//   { text, approvalId }  → verifies (fail-closed) and records the dispatch.
// Editor+.

import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole } from "@/lib/authz";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  OpsGateError,
  executeInvoiceReminder,
  proposeInvoiceReminder,
} from "@/lib/ops/invoices";
import { OpsError } from "@/lib/ops/doctype";
import { errorResponse } from "@/lib/api/errors";

export const dynamic = "force-dynamic";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) {
    return Response.json({ error: "Forbidden: editor role required" }, { status: 403 });
  }
  try {
    const { id } = await params;
    const body = (await req.json().catch(() => ({}))) as {
      text?: unknown;
      approvalId?: unknown;
    };
    const text = typeof body.text === "string" ? body.text : "";
    const approvalId = typeof body.approvalId === "string" ? body.approvalId : undefined;
    const actor = { workspaceId: workspace.id, userId: user.id };
    const result = approvalId
      ? await withWorkspaceScope(workspace.id, (tx) =>
          executeInvoiceReminder(tx, actor, id, text, approvalId),
        )
      : await withWorkspaceScope(workspace.id, (tx) =>
          proposeInvoiceReminder(tx, actor, id, text),
        );
    if (result.outcome === "approval_required") {
      return Response.json({ approval_required: true, approval: result.approval }, { status: 202 });
    }
    return Response.json({ done: true, invoiceId: result.invoiceId });
  } catch (err) {
    if (err instanceof OpsError) {
      return Response.json({ error: err.message }, { status: err.status });
    }
    if (err instanceof OpsGateError) {
      return Response.json({ error: err.message, code: err.code }, { status: 422 });
    }
    return errorResponse(err);
  }
}
