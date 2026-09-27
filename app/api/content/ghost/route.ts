// Marketr — Ghost publish action (Phase 12 "embeds").
// POST /api/content/ghost  { contentId, publish?: boolean }
//   Creates a Ghost post from the content item's body markdown (draft by
//   default; `publish: true` publishes immediately) and stores the Ghost
//   post id + status on the item.
// GET /api/content/ghost?contentId=...
//   Refreshes the stored status from Ghost's own API (draft/published).
// Without GHOST_URL + GHOST_ADMIN_API_KEY → 503 with an honest message.

import { z } from "zod";
import { accessibleWorkspaceWhere, requireProjectRole, forbidden } from "@/lib/authz";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { readJson } from "@/lib/enrichment/guard";
import {
  GhostApiError,
  createGhostPost,
  getGhostPost,
  ghostStatus,
  markdownToHtml,
} from "@/lib/integrations/ghost";

export const dynamic = "force-dynamic";

const PostSchema = z.object({
  contentId: z.string().min(1),
  publish: z.boolean().optional(),
});

async function getItem(userId: string, contentId: string) {
  const item = await prisma.contentItem.findFirst({
    where: {
      id: contentId,
      project: { workspace: accessibleWorkspaceWhere(userId) },
    },
    include: { keyword: { select: { phrase: true } } },
  });
  if (!item) return null;
  if (!(await requireProjectRole(userId, item.projectId, "editor"))) return "forbidden";
  return item;
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!ghostStatus().configured) {
    return Response.json(
      { error: "Ghost is not configured. Set GHOST_URL and GHOST_ADMIN_API_KEY on the host." },
      { status: 503 },
    );
  }
  const parsed = PostSchema.safeParse(await readJson(req).catch(() => ({})));
  if (!parsed.success) {
    return Response.json({ error: "Invalid input" }, { status: 400 });
  }
  const item = await getItem(user.id, parsed.data.contentId);
  if (item === "forbidden") return forbidden();
  if (!item) return Response.json({ error: "Content item not found" }, { status: 404 });
  if (!item.bodyMarkdown?.trim()) {
    return Response.json(
      { error: "Generate a draft first — Ghost publishing needs body content." },
      { status: 400 },
    );
  }

  const title = item.keyword?.phrase ?? `Content ${item.id.slice(0, 8)}`;
  try {
    const post = await createGhostPost({
      title,
      html: markdownToHtml(item.bodyMarkdown),
      status: parsed.data.publish === true ? "published" : "draft",
    });
    const updated = await prisma.contentItem.update({
      where: { id: item.id },
      data: {
        ghostPostId: post.id,
        ghostStatus: post.status,
        ghostUrl: post.url || null,
      },
      select: { id: true, ghostPostId: true, ghostStatus: true, ghostUrl: true },
    });
    return Response.json({ contentItem: updated, ghost: post }, { status: 201 });
  } catch (e) {
    if (e instanceof GhostApiError) {
      return Response.json({ error: e.message }, { status: e.status === 0 ? 502 : e.status });
    }
    throw e;
  }
}

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const contentId = new URL(req.url).searchParams.get("contentId") ?? "";
  const item = await getItem(user.id, contentId);
  if (item === "forbidden") return forbidden();
  if (!item) return Response.json({ error: "Content item not found" }, { status: 404 });
  if (!item.ghostPostId) {
    return Response.json({
      contentItem: {
        id: item.id,
        ghostPostId: null,
        ghostStatus: null,
        ghostUrl: null,
      },
    });
  }
  if (!ghostStatus().configured) {
    // Keep showing the last-known status when Ghost is unreachable.
    return Response.json({
      contentItem: {
        id: item.id,
        ghostPostId: item.ghostPostId,
        ghostStatus: item.ghostStatus,
        ghostUrl: item.ghostUrl,
      },
      stale: true,
    });
  }
  try {
    const post = await getGhostPost(item.ghostPostId);
    const updated = await prisma.contentItem.update({
      where: { id: item.id },
      data: { ghostStatus: post.status, ghostUrl: post.url || item.ghostUrl },
      select: { id: true, ghostPostId: true, ghostStatus: true, ghostUrl: true },
    });
    return Response.json({ contentItem: updated });
  } catch (e) {
    if (e instanceof GhostApiError) {
      return Response.json({ error: e.message }, { status: e.status === 0 ? 502 : e.status });
    }
    throw e;
  }
}
