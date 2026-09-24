// Marketr — Calls API: tracking numbers.
// GET  /api/calls/numbers → list (workspace-scoped)
// POST /api/calls/numbers (editor+) → purchase a number via the active provider

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { getProvider } from "@/lib/calls/provider";
import { publicOrigin } from "@/lib/physical/bundles";

const PurchaseSchema = z.object({
  areaCode: z.string().trim().max(10).optional(),
  friendlyName: z.string().trim().max(64).optional(),
  campaign: z.string().trim().max(160).optional(),
});

export async function GET() {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);

  const numbers = await prisma.callNumber.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { calls: true } } },
  });
  return Response.json({ numbers, workspaceId: workspace.id });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "editor"))) return forbidden();

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = PurchaseSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }
  const d = parsed.data;

  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Provider unconfigured" }, { status: 500 });
  }

  const origin = publicOrigin(req);
  let purchased;
  try {
    purchased = await provider.purchaseNumber({
      areaCode: d.areaCode,
      friendlyName: d.friendlyName,
      campaign: d.campaign,
      voiceUrl: `${origin}/api/calls/webhooks/twilio/voice`,
      statusCallbackUrl: `${origin}/api/calls/webhooks/twilio/status`,
    });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "Purchase failed" }, { status: 502 });
  }

  try {
    const number = await prisma.callNumber.create({
      data: {
        workspaceId: workspace.id,
        e164: purchased.e164,
        provider: provider.name,
        providerSid: purchased.providerSid,
        friendlyName: d.friendlyName ?? null,
        campaign: d.campaign ?? null,
        status: "active",
      },
    });
    return Response.json({ number }, { status: 201 });
  } catch (e) {
    // Number bought upstream but row write failed — best effort release so
    // the workspace isn't billed for an orphan number.
    try { await provider.releaseNumber(purchased.e164); } catch { /* ignore */ }
    throw e;
  }
}
