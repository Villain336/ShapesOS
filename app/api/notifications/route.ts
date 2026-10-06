// ShapesOS — GET /api/notifications[?limit=20&unread=1&before=<iso>]
// → { notifications, unread }
//
// The signed-in member's own notifications in the current workspace, newest
// first, plus their unread count (the header bell polls this with limit=8).

import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership, forbidden } from "@/lib/authz";
import { intQuery, parseQuery } from "@/lib/api/validate";
import { listNotifications, unreadCount } from "@/lib/notifications/store";
import { releaseHeldNotifications } from "@/lib/desktop/focus.server";

export const dynamic = "force-dynamic";

const QuerySchema = z.object({
  limit: intQuery(20, 1, 100),
  unread: z.enum(["0", "1"]).optional(),
  before: z.iso.datetime().optional(),
});

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await getMembership(user.id, workspace.id))) return forbidden();

  const q = parseQuery(QuerySchema, new URL(req.url).searchParams);
  if (!q.ok) return q.error;

  // Phase 18.1 (WS=desk): focus ended since the last poll → deliver what it queued.
  await releaseHeldNotifications(user.id).catch(() => 0);

  const scope = { userId: user.id, workspaceId: workspace.id };
  const [notifications, unread] = await Promise.all([
    listNotifications(prisma, {
      ...scope,
      limit: q.data.limit,
      unreadOnly: q.data.unread === "1",
      before: q.data.before ?? null,
    }),
    unreadCount(prisma, scope),
  ]);
  return Response.json({ notifications, unread }, { headers: { "Cache-Control": "private, no-store" } });
}
