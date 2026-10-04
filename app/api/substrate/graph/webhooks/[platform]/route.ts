// Marketr — Phase 8 G1: Tier-W webhook ingest endpoint.
// POST /api/substrate/graph/webhooks/:platform
//
// Signed ingest only (§9.8): the platform's HMAC signature is verified
// against the vault-held webhook secret, then replay protection runs.
// Failures return the honest status — never a silent 200.
// Query: ?workspaceId= (the connector is resolved per workspace+platform).
// The raw body MUST be read as text — HMAC is over the exact bytes.

import type { NextRequest } from "next/server";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import {
  verifyTierWWebhook,
  ingestTierWEvent,
  type TierWPlatform,
} from "@/lib/substrate/graph/connectors/tierw";
import { TIER_W } from "@/lib/substrate/graph/connectors/types";

export const dynamic = "force-dynamic";

const TOPIC_HEADERS: Record<TierWPlatform, string[]> = {
  hubspot: [],
  shopify: ["x-shopify-topic"],
  meta: [],
  salesforce: [],
};

export async function POST(req: NextRequest, ctx: { params: Promise<{ platform: string }> }) {
  const { platform } = await ctx.params;
  if (!(TIER_W as string[]).includes(platform)) {
    return Response.json({ error: `unknown Tier-W platform: ${platform}` }, { status: 404 });
  }
  const workspaceId = req.nextUrl.searchParams.get("workspaceId");
  if (!workspaceId) {
    return Response.json({ error: "workspaceId is required" }, { status: 400 });
  }

  const rawBody = await req.text();
  const headers: Record<string, string | null> = {};
  for (const h of [
    "x-hubspot-signature-v3",
    "x-hubspot-request-timestamp",
    "x-shopify-hmac-sha256",
    "x-shopify-topic",
    "x-shopify-webhook-id",
    "x-hub-signature-256",
    "x-wc-webhook-signature",
    "x-sfdc-signature",
  ]) {
    headers[h] = req.headers.get(h);
  }

  const connector = await withWorkspaceScope(workspaceId, (tx) =>
    tx.graphConnector.findFirst({
      where: { workspaceId, platform: platform as TierWPlatform },
    }),
  );
  if (!connector) {
    return Response.json(
      { error: `${platform} connector not registered for this workspace` },
      { status: 404 },
    );
  }

  const verified = await verifyTierWWebhook({
    platform: platform as TierWPlatform,
    connector,
    method: req.method,
    uri: req.nextUrl.pathname + req.nextUrl.search,
    headers,
    rawBody,
  });
  if (!verified.ok) {
    return Response.json({ error: verified.detail }, { status: verified.status });
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const topic =
    TOPIC_HEADERS[platform as TierWPlatform]
      .map((h) => headers[h])
      .find((v) => v) ?? "";

  // Phase 11 (bizsync): a verified Shopify webhook for orders / products /
  // customers / inventory is also applied to Ops (idempotent through
  // biz_sync_links). Topics the graph mapper has no facts for (customers,
  // inventory levels) skip the graph ingest instead of dead-lettering.
  let ops: { applied: boolean; detail: string } | null = null;
  if (platform === "shopify") {
    const { applyShopifyWebhook, isOpsTopic } = await import("@/lib/bizsync/shopify/sync");
    try {
      const r = await applyShopifyWebhook(workspaceId, topic ?? "", body);
      ops = { applied: r.applied, detail: r.detail };
    } catch (err) {
      ops = { applied: false, detail: `Ops apply failed: ${err instanceof Error ? err.message.slice(0, 200) : "error"}` };
    }
    if (isOpsTopic(topic ?? "") && !/^(orders|products)\//.test(topic ?? "")) {
      return Response.json({ accepted: true, status: 202, factsAppended: 0, detail: "applied to Ops only", ops }, { status: 202 });
    }
  }

  const result = await ingestTierWEvent({
    platform: platform as TierWPlatform,
    connector,
    topic: topic ?? "",
    body,
    rawBody,
  });
  return Response.json(ops ? { ...result, ops } : result, { status: result.status });
}
