// ShapesOS — social posts (Phase 4b).
// GET  /api/social/posts?from=&to=&status=  → { posts } (viewer+)
// POST /api/social/posts { content, link?, utmCampaign?, channels, media, publishMode, scheduledFor? }
//   → { post } as a draft (editor+). Publishing goes through submit → approval.

import { validateBody } from "@/lib/api/validate";
import { createPost, listPosts } from "@/lib/social/publications";
import { BadRequestError } from "@/lib/api/errors";
import type { SocialPublicationStatus } from "@prisma/client";
import { PostBodySchema, guardWorkspace, readJson, socialError, toChannels, toMedia } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const STATUSES: SocialPublicationStatus[] = ["draft", "pending_approval", "approved", "scheduled", "published", "failed", "cancelled"];

function dateParam(sp: URLSearchParams, key: string): Date | undefined {
  const raw = sp.get(key);
  if (!raw) return undefined;
  const d = new Date(raw);
  if (!Number.isFinite(d.getTime())) throw new BadRequestError(`${key} must be a valid date.`);
  return d;
}

export async function GET(req: Request) {
  try {
    const { workspace } = await guardWorkspace();
    const sp = new URL(req.url).searchParams;
    const status = sp.get("status");
    if (status && !(STATUSES as string[]).includes(status)) throw new BadRequestError("Unknown status.");
    const posts = await listPosts(workspace.id, {
      from: dateParam(sp, "from"),
      to: dateParam(sp, "to"),
      status: (status as SocialPublicationStatus | null) ?? undefined,
    });
    return Response.json({ posts });
  } catch (e) {
    return socialError(e);
  }
}

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const v = validateBody(PostBodySchema, await readJson(req));
    if (!v.ok) return v.error;
    const post = await createPost(workspace.id, user.id, {
      ...v.data,
      channels: toChannels(v.data.channels),
      media: toMedia(v.data.media),
    });
    return Response.json({ post }, { status: 201 });
  } catch (e) {
    return socialError(e);
  }
}
