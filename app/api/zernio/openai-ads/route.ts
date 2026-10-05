// ShapesOS — Phase 15.4 (zernio): connect OpenAI Ads (ChatGPT Ads Manager key).
// POST /api/zernio/openai-ads { workspaceId, apiKey } (admin+) → { account }
// connectOpenAIAdsCredentials (POST /v1/connect/openai-ads/credentials): the
// customer's own key is handed to Zernio for THIS workspace's profile and is
// never stored or logged by ShapesOS.

import type { NextRequest } from "next/server";
import { auditEvent } from "@/lib/auditlog";
import { validateBody, z } from "@/lib/api/validate";
import { checkRateLimitAsync, tooManyRequests } from "@/lib/api/rate-limit";
import { connectOpenAIAds } from "@/lib/zernio/connect";
import { getZernioScope } from "@/lib/zernio/tenancy";
import { zernioErrorResponse, zernioGuard } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const Body = z.object({ workspaceId: z.string().min(1).max(64), apiKey: z.string().min(8).max(500) });

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
    const account = await connectOpenAIAds(scope, v.data.apiKey);
    await auditEvent({
      projectId: null,
      workspaceId: g.workspaceId,
      action: "zernio_account_connected",
      summary: `Zernio: connected OpenAI Ads (${account.accountId})`,
      actorUserId: g.userId,
    });
    return Response.json({ account: { accountId: account.accountId, platform: account.platform } });
  } catch (e) {
    return zernioErrorResponse(e);
  }
}
