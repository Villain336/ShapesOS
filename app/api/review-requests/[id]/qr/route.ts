// Marketr — R4: printable QR for one review request (viewer+).
// GET /api/review-requests/[id]/qr → { qrDataUrl, pageUrl, reviewUrl }

import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { requireWorkspaceRole, forbidden } from "@/lib/authz";
import { requestQrDataUrl, reviewPageUrl, ReviewEngineError } from "@/lib/reviews/engine";
import { publicOrigin } from "@/lib/physical/bundles";
import { prisma } from "@/lib/prisma";

export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  const { id } = await ctx.params;
  const reviewRequest = await prisma.reviewRequest.findFirst({
    where: { id, workspaceId: workspace.id },
  });
  if (!reviewRequest) {
    return Response.json({ error: "Review request not found", code: "not_found" }, { status: 404 });
  }

  const origin = publicOrigin(req);
  const pageUrl = reviewPageUrl(origin, reviewRequest.token);
  try {
    const qrDataUrl = await requestQrDataUrl(origin, reviewRequest.token);
    return Response.json({
      qrDataUrl,
      pageUrl,
      reviewUrl: reviewRequest.reviewUrl,
      status: reviewRequest.status,
    });
  } catch (e) {
    if (e instanceof ReviewEngineError) {
      return Response.json({ error: e.message, code: e.code }, { status: 400 });
    }
    throw e;
  }
}
