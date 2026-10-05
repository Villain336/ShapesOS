// ShapesOS — Studio design → social post draft (Phase 4b).
// POST /api/studio/designs/[id]/send-to-social { pageId?, scale? } → { post, href } (editor+)
// Renders the saved design page to PNG, stores it under /files/social/studio/
// and creates a DRAFT post with the image attached. Publishing still goes
// through submit → approval in Social; this route never publishes.

import { z } from "zod";
import { validateBody } from "@/lib/api/validate";
import { sendDesignToSocial } from "@/lib/social/studio";
import { MAX_RENDER_SCALE } from "@/lib/design/render-server";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { guardWorkspace, readJson, socialError } from "@/app/api/social/_lib";
import { sidecarScoped } from "@/lib/integrations/sidecar-scope";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  pageId: z.string().trim().min(1).max(128).optional(),
  scale: z.number().finite().min(1).max(MAX_RENDER_SCALE).optional(),
});

async function handlePOST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { user, workspace } = await guardWorkspace({ editor: true });
    // Rendering is expensive compute: same "ai" tier as the render route.
    const rl = await checkRateLimitAsync(`studio-render:ws:${workspace.id}`, "ai");
    if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
    const raw = req.headers.get("content-length") === "0" ? {} : await readJson(req).catch(() => ({}));
    const v = validateBody(Body, raw ?? {});
    if (!v.ok) return v.error;
    const { id } = await ctx.params;
    const { post, warnings } = await sendDesignToSocial(workspace.id, user.id, id, v.data);
    return Response.json(
      { post, warnings, href: `/dashboard/social?post=${encodeURIComponent(post.id)}` },
      { status: 201 },
    );
  } catch (e) {
    return socialError(e);
  }
}

// Phase 15.1: run in this workspace's sidecar scope — its own instance;
// a shared one is refused on hosted (lib/integrations/sidecar-tenancy.ts).
export const POST = sidecarScoped(handlePOST);
