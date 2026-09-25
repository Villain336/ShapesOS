// Marketr — Phase 8 G1: connector management API.
// GET /api/substrate/graph/connectors?workspaceId=
// POST /api/substrate/graph/connectors { platform, workspaceId } — start OAuth/key handoff
//
// Credential blobs are never returned: authRef/webhookSecretRef are vault
// reference ids only (§9.9).

import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/session";
import { workspaceIdFrom, requireWorkspaceAccess, badRequest } from "@/lib/route-utils";
import { withWorkspaceScope } from "@/lib/substrate/graph/rls";
import { platformSpec } from "@/lib/substrate/graph/connectors/types";
import { auditEvent } from "@/lib/auditlog";
import type { GraphConnectorPlatform } from "@prisma/client";

export const dynamic = "force-dynamic";

const PLATFORMS: GraphConnectorPlatform[] = [
  "hubspot",
  "salesforce",
  "shopify",
  "woocommerce",
  "google_ads",
  "meta",
  "tiktok",
  "linkedin",
];

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req), "viewer");
  if ("error" in access) return access.error;

  const connectors = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphConnector.findMany({
      where: { workspaceId: access.workspaceId },
      include: {
        syncJobs: {
          select: { id: true, tier: true, status: true, lastRunAt: true, lastSuccessAt: true, errorCount: true, backoffUntil: true },
          orderBy: { lastRunAt: "desc" },
          take: 3,
        },
      },
      orderBy: { platform: "asc" },
    }),
  );

  return Response.json({
    catalog: PLATFORMS.map((p) => {
      const spec = platformSpec(p);
      return {
        platform: p,
        displayName: spec.displayName,
        tier: spec.tier,
        honestyNote: spec.honestyNote,
        signatureScheme: spec.signatureScheme,
      };
    }),
    connectors: connectors.map((c) => ({
      id: c.id,
      platform: c.platform,
      tier: c.tier,
      status: c.status,
      scopesGranted: c.scopesGranted,
      hasAuth: !!c.authRef,
      hasWebhookSecret: !!c.webhookSecretRef,
      syncJobs: c.syncJobs.map((j) => ({
        ...j,
        lastRunAt: j.lastRunAt?.toISOString() ?? null,
        lastSuccessAt: j.lastSuccessAt?.toISOString() ?? null,
        backoffUntil: j.backoffUntil?.toISOString() ?? null,
      })),
    })),
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    workspaceId?: string;
    platform?: string;
    authRef?: string;
    webhookSecretRef?: string;
  } | null;
  const access = await requireWorkspaceAccess(user.id, workspaceIdFrom(req, body), "editor");
  if ("error" in access) return access.error;
  if (!body?.platform || !PLATFORMS.includes(body.platform as GraphConnectorPlatform)) {
    return badRequest(`platform must be one of: ${PLATFORMS.join(", ")}`);
  }
  const platform = body.platform as GraphConnectorPlatform;
  const spec = platformSpec(platform);

  const connector = await withWorkspaceScope(access.workspaceId, (tx) =>
    tx.graphConnector.upsert({
      where: { workspaceId_platform: { workspaceId: access.workspaceId, platform } },
      create: {
        workspaceId: access.workspaceId,
        platform,
        tier: spec.tier,
        status: body.authRef ? "connected" : "pending",
        authRef: body.authRef ?? null,
        webhookSecretRef: body.webhookSecretRef ?? null,
      },
      update: {
        ...(body.authRef ? { authRef: body.authRef, status: "connected" as const } : {}),
        ...(body.webhookSecretRef ? { webhookSecretRef: body.webhookSecretRef } : {}),
      },
    }),
  );

  await auditEvent({
    projectId: null,
    workspaceId: access.workspaceId,
    action: "graph_connector_changed",
    summary: `graph connector ${platform} → ${connector.status}`,
    actor: "user",
    actorUserId: user.id,
  }).catch(() => {});

  return Response.json(
    {
      id: connector.id,
      platform: connector.platform,
      tier: connector.tier,
      status: connector.status,
      // Honest next step — the UI shows this, not a fake "connected" state.
      nextStep: body.authRef
        ? "credentials stored in vault — run a manual sync to verify"
        : spec.tier === "manual" && platform === "woocommerce"
          ? "paste the per-site WooCommerce consumer key/secret (Settings → Advanced → REST API)"
          : `complete OAuth for ${spec.displayName}, then paste the vault reference`,
    },
    { status: 201 },
  );
}
