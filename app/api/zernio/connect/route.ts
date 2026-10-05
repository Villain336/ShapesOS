// ShapesOS — Phase 15.4 (zernio): start "Connect an account".
// POST /api/zernio/connect { workspaceId, kind: "social"|"ads", platform, postingAccountId? } (admin+)
//   → { authUrl } (send the browser there) or { alreadyConnected: true, account }
// The first connect creates the workspace's Zernio profile (once, under a lock).
// The authUrl is Zernio's hosted consent screen for THIS workspace's profile;
// it returns to /api/zernio/callback with a state signed for this user.

import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/auditlog";
import { validateBody, z } from "@/lib/api/validate";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { startConnect } from "@/lib/zernio/connect";
import { getZernioScope } from "@/lib/zernio/tenancy";
import { zernioErrorResponse, zernioGuard } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({
  workspaceId: z.string().min(1).max(64),
  kind: z.enum(["social", "ads"]),
  platform: z.string().min(1).max(40),
  postingAccountId: z.string().max(64).optional().nullable(),
});

export async function POST(req: NextRequest) {
  const raw = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const g = await zernioGuard(req, "admin", raw);
  if (g instanceof Response) return g;
  const v = validateBody(Body, raw);
  if (!v.ok) return v.error;
  const rl = await checkRateLimitAsync(`zernio-connect:ws:${g.workspaceId}`, "write");
  if (!rl.allowed) return tooManyRequests(rl.retryAfterMs);
  try {
    const scope = await getZernioScope(g.workspaceId, { userId: g.userId });
    const out = await startConnect(scope, {
      kind: v.data.kind,
      platform: v.data.platform,
      origin: req.nextUrl.origin,
      userId: g.userId,
      postingAccountId: v.data.postingAccountId ?? null,
    });
    await auditEvent({
      projectId: null,
      workspaceId: g.workspaceId,
      action: "zernio_connect_started",
      summary: `Zernio: connect ${v.data.kind} ${v.data.platform}${out.kind === "already_connected" ? " (already connected)" : ""}`,
      actorUserId: g.userId,
    });
    if (out.kind === "already_connected") {
      return Response.json({ alreadyConnected: true, account: { accountId: out.account.accountId, platform: out.account.platform } });
    }
    return Response.json({ authUrl: out.authUrl });
  } catch (e) {
    return zernioErrorResponse(e);
  }
}
