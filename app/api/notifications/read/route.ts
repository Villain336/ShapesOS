// ShapesOS — POST /api/notifications/read
//   { ids: string[] }  → mark those read
//   { all: true }      → mark every notification read ("Mark all read")
// → { updated, unread }
//
// Only ever touches the caller's own notifications in the current workspace.

import { prisma } from "@/lib/prisma";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { forbidden, requireWorkspaceRole } from "@/lib/authz";
import { validateBody, z } from "@/lib/api/validate";
import { markAllRead, markRead, unreadCount } from "@/lib/notifications/store";

export const dynamic = "force-dynamic";

const BodySchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().trim().min(1).max(64)).min(1).max(200) }),
]);

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  if (!(await requireWorkspaceRole(user.id, workspace.id, "viewer"))) return forbidden();

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = validateBody(BodySchema, raw);
  if (!parsed.ok) return parsed.error;

  const scope = { userId: user.id, workspaceId: workspace.id };
  const updated =
    "all" in parsed.data
      ? await markAllRead(prisma, scope)
      : await markRead(prisma, { ...scope, ids: parsed.data.ids });
  return Response.json({ updated, unread: await unreadCount(prisma, scope) });
}
