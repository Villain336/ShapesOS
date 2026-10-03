// Marketr — R4: review requests.
// GET  /api/review-requests → requests + funnel stats (?status=, ?limit=)
// POST /api/review-requests (editor+) → send one review request
//   { leadId, channel: "sms"|"email" }

import { z } from "zod";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import {
  sendReviewRequest,
  listReviewRequests,
  funnelStats,
  ReviewEngineError,
} from "@/lib/reviews/engine";
import { publicOrigin } from "@/lib/physical/bundles";
import { intQuery, parseQuery } from "@/lib/api/validate";

const SendSchema = z.object({
  leadId: z.string().trim().min(1).max(64),
  channel: z.enum(["sms", "email"]),
  delayDays: z.number().int().min(0).max(90).optional(),
});

async function guard(reqRole: "viewer" | "editor" = "viewer") {
  const user = await requireUser();
  if (!user) return { error: Response.json({ error: "Unauthorized" }, { status: 401 }) as Response };
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, reqRole))) {
    return { error: forbidden() as Response };
  }
  return { user, workspace };
}

export async function GET(req: Request) {
  const g = await guard("viewer");
  if (g.error) return g.error;
  const url = new URL(req.url);
  const status = url.searchParams.get("status") || undefined;
  const limitQuery = parseQuery(z.object({ limit: intQuery(100, 1, 500) }), url.searchParams);
  if (!limitQuery.ok) return limitQuery.error;
  const limit = limitQuery.data.limit;
  const [requests, stats] = await Promise.all([
    listReviewRequests(g.workspace!.id, { status, limit }),
    funnelStats(g.workspace!.id),
  ]);
  const origin = publicOrigin(req);
  return Response.json({
    requests: requests.map((r) => ({
      ...r,
      pageUrl: `${origin}/r/review/${r.token}`,
    })),
    stats,
    workspaceId: g.workspace!.id,
  });
}

export async function POST(req: Request) {
  const g = await guard("editor");
  if (g.error) return g.error;

  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = SendSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Invalid input", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    const res = await sendReviewRequest({
      workspaceId: g.workspace!.id,
      leadId: parsed.data.leadId,
      channel: parsed.data.channel,
      origin: publicOrigin(req),
      requestedBy: g.user!.id,
      delayDays: parsed.data.delayDays,
    });
    return Response.json(
      {
        reviewRequest: { ...res.reviewRequest, pageUrl: res.pageUrl },
        approvalId: res.approval.id,
        approvalStatus: res.approval.status,
        messageId: res.message.id,
        messageStatus: res.message.status,
      },
      { status: 201 },
    );
  } catch (e) {
    if (e instanceof ReviewEngineError) {
      const status =
        e.code === "suppressed" ? 409
        : e.code === "no_config" ? 422
        : 400;
      return Response.json({ error: e.message, code: e.code }, { status });
    }
    throw e;
  }
}
