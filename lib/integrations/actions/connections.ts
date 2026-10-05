// Marketr — Phase 14: Composio connection service.
//
// One row per (workspace, appKey) in composio_connections. Marketr stores
// ONLY the opaque Composio connected_account_id — never raw OAuth tokens
// (locked trust boundary: Composio hosted).
//
// Connect flow: initiateConnect() mints a FRESH Composio OAuth link at
// click time (redirect_url expires ~12 min — never cached). The DB row is
// created/updated by confirmConnection() after the OAuth round-trip lands
// on our callback route.

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import {
  createComposioAuthConfig,
  createComposioConnectLink,
  getComposioAuthConfigId,
  type ComposioHttp,
} from "@/lib/integrations/composio";
import { getV1App, isValidTier } from "@/lib/integrations/actions/risk";
import { signOAuthState } from "@/lib/integrations/actions/oauth-state";
import { refreshCatalogForConnection } from "@/lib/integrations/actions/discovery";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/api/errors";

export interface InitiateConnectResult {
  connectUrl: string;
  expiresAt: string | null;
}

/** Public origin for the OAuth callback (same pattern as the messaging dispatcher). */
function publicOrigin(): string {
  return (
    process.env.APP_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000"
  ).replace(/\/$/, "");
}

function requireV1App(appKey: string) {
  const app = getV1App(appKey);
  if (!app) {
    throw new BadRequestError(
      `Unknown app "${appKey}". v1 apps: gmail, google-sheets, slack, hubspot, notion.`,
    );
  }
  return app;
}

/** Mint a fresh OAuth connect link for (workspace, app). No DB row yet —
 *  the row lands in confirmConnection() after the OAuth round-trip.
 *
 *  Hardened (slice 4): the link request carries a redirect_url pointing at
 *  our callback with a SIGNED state token binding (workspaceId, appKey,
 *  userId). The callback verifies the signature before confirming — an
 *  unsigned/forged callback cannot bind an arbitrary connected_account_id. */
export async function initiateConnect(
  opts: { workspaceId: string; appKey: string; userId: string },
  http?: ComposioHttp,
): Promise<InitiateConnectResult> {
  const app = requireV1App(opts.appKey);
  let authConfigId = await getComposioAuthConfigId(app.toolkitSlug, http);
  if (!authConfigId) {
    const created = await createComposioAuthConfig(
      app.toolkitSlug,
      `marketr-${app.appKey}`,
      http,
    );
    authConfigId = created.id;
  }
  // Hardened (slice 4): sign the (workspaceId, appKey, userId) binding and
  // carry it as ?state= on the callback URL. signOAuthState runs FIRST
  // (fail-closed): no secret -> no link. The callback verifies the
  // signature before confirming — forged callbacks can't bind.
  const state = signOAuthState({
    workspaceId: opts.workspaceId,
    appKey: opts.appKey,
    userId: opts.userId,
  });
  const redirectUrl = `${publicOrigin()}/api/integrations/actions/callback?state=${encodeURIComponent(state)}`;
  const link = await createComposioConnectLink(
    { authConfigId, userId: opts.userId, redirectUrl },
    http,
  );
  if (!link.redirect_url) throw new Error("Composio returned no redirect_url");
  return { connectUrl: link.redirect_url, expiresAt: link.expires_at ?? null };
}

/** Upsert the connection row after a successful OAuth round-trip. */
export async function confirmConnection(opts: {
  workspaceId: string;
  appKey: string;
  connectedAccountId: string;
  scopes?: string[];
}): Promise<{ id: string; status: string }> {
  requireV1App(opts.appKey);
  if (!opts.connectedAccountId.trim()) throw new BadRequestError("connectedAccountId is required");
  const row = await withWorkspaceScope(opts.workspaceId, async (tx) => {
    const row = await tx.composioConnection.upsert({
      where: {
        workspaceId_appKey: { workspaceId: opts.workspaceId, appKey: opts.appKey },
      },
      update: {
        composioEntityId: opts.connectedAccountId,
        status: "connected",
        scopes: opts.scopes ?? [],
        lastError: null,
      },
      create: {
        workspaceId: opts.workspaceId,
        appKey: opts.appKey,
        composioEntityId: opts.connectedAccountId,
        status: "connected",
        scopes: opts.scopes ?? [],
      },
      select: { id: true, status: true },
    });
    return row;
  });
  // Phase 15 slice 1: seed/refresh the per-workspace tool catalog on connect
  // finalize (live discovery with COMPOSIO_API_KEY, fixtures without). Best-effort:
  // a catalog miss must never break connection finalize.
  try {
    await refreshCatalogForConnection(opts.workspaceId, opts.appKey);
  } catch (e) {
    console.warn(
      `[phase15] catalog refresh for ${opts.appKey} failed: ${(e as Error).message}`,
    );
  }
  return row;
}

export async function listConnections(workspaceId: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.composioConnection.findMany({
      where: { workspaceId },
      orderBy: { appKey: "asc" },
      select: {
        id: true,
        appKey: true,
        status: true,
        scopes: true,
        lastError: true,
        connectedAt: true,
        updatedAt: true,
      },
    }),
  );
}

/** Revoke = soft status flip. The OAuth grant itself is revoked in the
 *  Composio dashboard / native app; we stop using the entity id. */
export async function revokeConnection(workspaceId: string, id: string) {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const existing = await tx.composioConnection.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundError("Connection not found");
    return tx.composioConnection.update({
      where: { id, workspaceId },
      data: { status: "revoked", lastError: null },
      select: { id: true, status: true },
    });
  });
}

/** Look up the connected entity id for tool execution. Throws when the
 *  app is not connected — execution without a connection fails closed. */
export async function requireConnectedEntity(
  workspaceId: string,
  appKey: string,
): Promise<string> {
  const row = await withWorkspaceScope(workspaceId, (tx) =>
    tx.composioConnection.findFirst({
      where: { workspaceId, appKey, status: "connected" },
      select: { composioEntityId: true },
    }),
  );
  if (!row) throw new ConflictError(`App "${appKey}" is not connected in this workspace.`);
  return row.composioEntityId;
}

// ---------------------------------------------------------------------------
// Per-workspace risk-tier overrides (manual > derived). Stored on
// WorkspaceSettings.toolTierOverrides as { TOOL_SLUG: "low"|"medium"|"high" }.
// ---------------------------------------------------------------------------

export async function getToolTierOverrides(
  workspaceId: string,
): Promise<Record<string, string>> {
  const settings = await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceSettings.findUnique({
      where: { workspaceId },
      select: { toolTierOverrides: true },
    }),
  );
  const raw = settings?.toolTierOverrides;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && isValidTier(v)) out[k.toUpperCase()] = v;
  }
  return out;
}

export async function setToolTierOverrides(
  workspaceId: string,
  overrides: Record<string, string>,
): Promise<Record<string, string>> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides)) {
    if (!isValidTier(v)) throw new BadRequestError(`Invalid tier "${v}" for tool "${k}"`);
    clean[k.toUpperCase()] = v;
  }
  await withWorkspaceScope(workspaceId, (tx) =>
    tx.workspaceSettings.upsert({
      where: { workspaceId },
      update: { toolTierOverrides: clean },
      create: { workspaceId, agentAllowList: [], toolTierOverrides: clean },
    }),
  );
  return clean;
}
