// ShapesOS — upload social media (Phase 4b).
// POST /api/social/media  multipart: file → { media } (editor+)
// Images (JPEG, PNG, GIF, WebP) and video (MP4, MOV, WebM), sniffed from the
// bytes; stored in the workspace filesystem under /files/social/uploads/.
// Per-platform limits are checked when the post is submitted.

import { storeSocialMedia } from "@/lib/social/publications";
import { socialMaxUploadBytes } from "@/lib/social/platforms";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { BadRequestError, HttpError } from "@/lib/api/errors";
import { guardWorkspace, socialError } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    const rl = await checkRateLimitAsync(`social-media:ws:${workspace.id}`, "write");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
    const cap = socialMaxUploadBytes();
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > cap + 64 * 1024) {
      throw new HttpError(413, `Files can be up to ${Math.floor((cap / 1024 / 1024) * 10) / 10} MB.`);
    }
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new BadRequestError("Attach a file in the \"file\" field.");
    if (file.size > cap) throw new HttpError(413, `Files can be up to ${Math.floor((cap / 1024 / 1024) * 10) / 10} MB.`);
    const media = await storeSocialMedia({
      workspaceId: workspace.id,
      userId: user.id,
      bytes: Buffer.from(await file.arrayBuffer()),
      filename: file.name || "media",
    });
    return Response.json({ media }, { status: 201 });
  } catch (e) {
    return socialError(e);
  }
}
