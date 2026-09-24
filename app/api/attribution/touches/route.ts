// Marketr — Attribution API: manual touch logging.
// POST /api/attribution/touches (editor+) → record a visit/call/form/manual
// touch on a lead. The `first` touch type is reserved for lead creation.

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { logTouch } from "@/lib/attribution/touches";

const ManualTouchSchema = z.object({
  leadId: z.string().min(1).max(64),
  channel: z.string().trim().min(1).max(64),
  source: z.string().trim().max(160).optional(),
  medium: z.string().trim().max(80).optional(),
  campaign: z.string().trim().max(160).optional(),
  contentId: z.string().trim().max(64).optional(),
  touchType: z.enum(["visit", "form", "call", "manual"]).default("manual"),
  occurredAt: z.coerce.date().optional(),
});

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = ManualTouchSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  try {
    const touch = await logTouch({
      workspaceId: workspace.id,
      leadId: d.leadId,
      channel: d.channel,
      source: d.source ?? null,
      medium: d.medium ?? null,
      campaign: d.campaign ?? null,
      contentId: d.contentId ?? null,
      touchType: d.touchType,
      occurredAt: d.occurredAt,
      meta: { manual: true, actor: user.name ?? user.email ?? "User" },
    });
    return Response.json({ touch }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === "Lead not found in workspace") {
      return Response.json({ error: "Lead not found" }, { status: 404 });
    }
    throw e;
  }
}
