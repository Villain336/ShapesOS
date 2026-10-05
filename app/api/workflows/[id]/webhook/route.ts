// ShapesOS — automation canvas API: the webhook trigger's inbound URL and
// signing secret (Phase 6 runtime).
// GET    /api/workflows/[id]/webhook   URL + secret hint             (viewer+)
// POST   /api/workflows/[id]/webhook   mint or rotate the secret     (editor+)
// DELETE /api/workflows/[id]/webhook   revoke: the URL stops working (editor+)
//
// The raw secret is returned once, by POST, and never again (stored only as
// a secrets() envelope — lib/workflow/webhook.ts). Editor+ matches the manual
// run API: anyone who can run the workflow by hand can hand out its URL.

import { requireUser } from "@/lib/session";
import { isError, requireWorkflow } from "@/lib/workflow/http";
import { appBaseUrl } from "@/lib/workspace/invite-mail";
import {
  getWorkflowWebhook,
  revokeWorkflowWebhook,
  rotateWorkflowWebhookSecret,
  SIGNATURE_HEADER,
  type WorkflowWebhookView,
} from "@/lib/workflow/webhook";

export const dynamic = "force-dynamic";

function withUrl(req: Request, view: WorkflowWebhookView) {
  const requestOrigin = new URL(req.url).origin;
  const origin = appBaseUrl(process.env, requestOrigin) ?? requestOrigin;
  return { ...view, url: `${origin}${view.path}`, signatureHeader: SIGNATURE_HEADER };
}

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "viewer");
  if (isError(access)) return access.error;
  return Response.json({ webhook: withUrl(req, await getWorkflowWebhook(access.workflow.id)) });
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "editor");
  if (isError(access)) return access.error;
  const current = await getWorkflowWebhook(access.workflow.id);
  if (!current.hasTrigger) {
    return Response.json(
      { error: "Add a webhook trigger to this workflow and save it before creating a secret." },
      { status: 400 },
    );
  }
  const { secret, view } = await rotateWorkflowWebhookSecret(access.workflow.id, user.id);
  return Response.json({ webhook: withUrl(req, view), secret }, { status: current.configured ? 200 : 201 });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const access = await requireWorkflow(user.id, id, "editor");
  if (isError(access)) return access.error;
  await revokeWorkflowWebhook(access.workflow.id);
  return Response.json({ ok: true });
}
