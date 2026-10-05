// ShapesOS — Phase 15.4 (zernio): one Zernio profile per workspace, and the
// ownership checks every Zernio call goes through.
//
// The platform key (ZERNIO_API_KEY) belongs to ONE Zernio team shared by every
// ShapesOS workspace, so isolation is ours to enforce:
//   - getZernioScope() finds — or on first use creates, exactly once even
//     under concurrency (advisory lock + Idempotency-Key + a deterministic,
//     team-unique profile name) — the workspace's profile (createProfile,
//     POST /v1/profiles) and stores it under FORCE RLS (zernio_profiles).
//   - Every accountId an agent or a request names must be on THIS profile:
//     requireOwnedAccount() reads the workspace's own mirror first (RLS — a
//     foreign id is refused before any HTTP call), then confirms it live with
//     listAccounts?profileId=<ours>.
//   - Every platform ad account must be listed under an owned account
//     (listAdAccounts), and every campaign must come back from
//     listAdCampaigns?profileId=<ours> (the status / budget endpoints take a
//     bare platform campaign id, so this check is what scopes them).

import { Prisma, type ZernioAccount as ZernioAccountRow } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";
import type { ZernioClient } from "./client";
import { ZernioError } from "./client";
import { getFakeZernio, getZernioClient, isDefaultFakeClient } from "./config";
import {
  accountCategory,
  accountProfileId,
  isZernioId,
  type ZernioAccountDoc,
  type ZernioAccountHealthRow,
  type ZernioCampaignDoc,
} from "./spec";

export type { ZernioAccountRow };

/** A refusal because the id is not this workspace's — never reaches Zernio. */
export class ZernioScopeError extends Error {
  readonly code = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "ZernioScopeError";
  }
}

export interface ZernioScope {
  workspaceId: string;
  mode: "live" | "mock";
  profileId: string;
  profileRowId: string;
  client: ZernioClient;
}

/** Team-unique, deterministic profile name for a workspace (createProfile names are unique per team). */
export function profileNameFor(workspaceId: string): string {
  return `ShapesOS workspace ${workspaceId}`;
}

export function profileIdempotencyKey(workspaceId: string, mode: string): string {
  return `shapesos-zernio-profile-${mode}-${workspaceId}`;
}

const CONNECTOR_KEY = "zernio";

/**
 * The workspace's Zernio connection row (connector_connections, key
 * "zernio") — what the agent's project data-source bindings point at. The
 * platform key is server-side; the row carries no credential.
 */
export async function ensureZernioConnection(
  workspaceId: string,
  userId: string,
  profileId: string,
  mode: string,
  db: Pick<Prisma.TransactionClient, "connectorConnection"> = prisma,
): Promise<string> {
  const existing = await db.connectorConnection.findFirst({
    where: { workspaceId, connectorKey: CONNECTOR_KEY },
    orderBy: { connectedAt: "asc" },
    select: { id: true, meta: true, status: true },
  });
  const meta = { label: `Zernio (platform key${mode === "mock" ? ", MOCK" : ""})`, profileId, mode };
  if (existing) {
    const m = (existing.meta ?? {}) as Record<string, unknown>;
    if (m.profileId !== profileId || m.mode !== mode || existing.status !== "active") {
      await db.connectorConnection.update({ where: { id: existing.id, workspaceId }, data: { meta, status: "active" } });
    }
    return existing.id;
  }
  const row = await db.connectorConnection.create({
    data: { workspaceId, connectorKey: CONNECTOR_KEY, userId, status: "active", scopes: [], meta },
    select: { id: true },
  });
  return row.id;
}

async function findProfileRow(workspaceId: string, mode: string) {
  return withWorkspaceScope(workspaceId, (tx) =>
    tx.zernioProfile.findUnique({ where: { workspaceId_mode: { workspaceId, mode } } }),
  );
}

/** Create the profile on Zernio, adopting the existing one on a name conflict (409 existingProfileId). */
async function createRemoteProfile(client: ZernioClient, workspaceId: string, mode: string): Promise<{ id: string; name: string }> {
  const name = profileNameFor(workspaceId);
  try {
    const p = await client.createProfile({ name, description: `ShapesOS workspace ${workspaceId}` }, profileIdempotencyKey(workspaceId, mode));
    return { id: p._id, name: p.name };
  } catch (e) {
    if (e instanceof ZernioError && e.status === 409) {
      const existing = typeof e.details?.existingProfileId === "string" ? e.details.existingProfileId : null;
      if (existing) return { id: existing, name };
      // In-flight duplicate (same Idempotency-Key still processing): find it by name.
      const found = (await client.listProfiles({ name }))[0];
      if (found) return { id: found._id, name: found.name };
    }
    throw e;
  }
}

/**
 * The workspace's Zernio scope; creates the profile on first use. Concurrent
 * first uses serialize on a per-(workspace, mode) advisory lock, so exactly
 * one createProfile is sent.
 */
export async function getZernioScope(
  workspaceId: string,
  opts: { client?: ZernioClient; userId?: string | null; create?: boolean } = {},
): Promise<ZernioScope> {
  const client = opts.client ?? getZernioClient();
  const mode = client.mode;
  let row = await findProfileRow(workspaceId, mode);
  if (!row) {
    if (opts.create === false) throw new ZernioScopeError("This workspace has no Zernio profile yet. Open Settings → Connectors → Zernio.");
    row = await withWorkspaceScope(
      workspaceId,
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`zernio-profile:${mode}:${workspaceId}`}, 0))`;
        const again = await tx.zernioProfile.findUnique({ where: { workspaceId_mode: { workspaceId, mode } } });
        if (again) return again;
        const remote = await createRemoteProfile(client, workspaceId, mode);
        const created = await tx.zernioProfile.create({
          data: { workspaceId, mode, profileId: remote.id, name: remote.name, createdBy: opts.userId ?? null },
        });
        // Under the same lock: concurrent first uses never race on the connection row.
        const owner = opts.userId ?? (await tx.workspace.findUnique({ where: { id: workspaceId }, select: { ownerUserId: true } }))?.ownerUserId ?? "system";
        await ensureZernioConnection(workspaceId, owner, created.profileId, mode, tx as unknown as Prisma.TransactionClient);
        return created;
      },
      { timeoutMs: 60_000 },
    );
  }
  // Dev mock mode: the in-memory fake forgets profiles on restart.
  if (mode === "mock" && isDefaultFakeClient(client)) getFakeZernio().adoptProfile(row.profileId, row.name);
  return { workspaceId, mode, profileId: row.profileId, profileRowId: row.id, client };
}

// ---------------------------------------------------------------------------
// The account mirror
// ---------------------------------------------------------------------------

function statusOf(doc: ZernioAccountDoc, health?: ZernioAccountHealthRow): "connected" | "needs_reconnect" | "disconnected" {
  if (!doc.isActive) return "disconnected";
  if (doc.needsReconnection || health?.needsReconnect) return "needs_reconnect";
  return "connected";
}

/** Accounts Zernio reports for OUR profile only (anything else is dropped, never mirrored). */
export async function liveProfileAccounts(scope: ZernioScope): Promise<ZernioAccountDoc[]> {
  const all = await scope.client.listAccounts({ profileId: scope.profileId });
  return all.filter((a) => accountProfileId(a) === scope.profileId && isZernioId(a._id));
}

export interface ZernioAccountView {
  accountId: string;
  platform: string;
  category: string;
  username: string | null;
  displayName: string | null;
  status: string;
  health: "healthy" | "warning" | "error" | "unknown";
  issues: string[];
  adAccountIds: string[];
  connectedAt: string;
}

/**
 * Bring the mirror in step with Zernio (listAccounts + getAllAccountsHealth,
 * both ?profileId=<ours>): upsert what Zernio lists, mark the rest
 * disconnected. Returns the workspace's accounts with health.
 */
export async function syncZernioAccounts(scope: ZernioScope): Promise<ZernioAccountView[]> {
  const docs = await liveProfileAccounts(scope);
  let health: ZernioAccountHealthRow[] = [];
  try {
    health = await scope.client.getAllAccountsHealth({ profileId: scope.profileId });
  } catch {
    health = [];
  }
  const healthBy = new Map(health.map((h) => [h.accountId, h]));
  const now = new Date();
  const seen = new Set(docs.map((d) => d._id));
  return withWorkspaceScope(scope.workspaceId, async (tx) => {
    for (const d of docs) {
      const h = healthBy.get(d._id);
      const data = {
        platform: d.platform,
        category: accountCategory(d.platform),
        username: d.username ?? null,
        displayName: d.displayName ?? null,
        status: statusOf(d, h),
        lastSeenAt: now,
        disconnectedAt: d.isActive ? null : now,
      };
      await tx.zernioAccount.upsert({
        where: { workspaceId_accountId: { workspaceId: scope.workspaceId, accountId: d._id } },
        create: { workspaceId: scope.workspaceId, profileRowId: scope.profileRowId, accountId: d._id, ...data },
        update: { profileRowId: scope.profileRowId, ...data },
      });
    }
    await tx.zernioAccount.updateMany({
      where: { workspaceId: scope.workspaceId, profileRowId: scope.profileRowId, accountId: { notIn: [...seen] }, status: { not: "disconnected" } },
      data: { status: "disconnected", disconnectedAt: now },
    });
    const rows = await tx.zernioAccount.findMany({
      where: { workspaceId: scope.workspaceId, profileRowId: scope.profileRowId },
      orderBy: [{ category: "asc" }, { platform: "asc" }, { connectedAt: "asc" }],
    });
    return rows.map((r) => {
      const h = healthBy.get(r.accountId);
      return {
        accountId: r.accountId,
        platform: r.platform,
        category: r.category,
        username: r.username,
        displayName: r.displayName,
        status: r.status,
        health: r.status === "disconnected" ? "unknown" : (h?.status ?? "unknown"),
        issues: h?.issues ?? [],
        adAccountIds: r.adAccountIds,
        connectedAt: r.connectedAt.toISOString(),
      };
    });
  });
}

/** The mirror row for an account of this workspace (null when it is not ours). No HTTP. */
export async function mirroredAccount(scope: Pick<ZernioScope, "workspaceId" | "profileRowId">, accountId: string): Promise<ZernioAccountRow | null> {
  if (!isZernioId(accountId)) return null;
  return withWorkspaceScope(scope.workspaceId, (tx) =>
    tx.zernioAccount.findFirst({ where: { workspaceId: scope.workspaceId, profileRowId: scope.profileRowId, accountId } }),
  );
}

/**
 * The connect callback's record step: the account Zernio redirected back
 * with must be listed on OUR profile right now (the redirect's own
 * profileId/accountId params are browser-controlled and never trusted).
 */
export async function recordConnectedAccount(scope: ZernioScope, accountId: string): Promise<ZernioAccountRow> {
  if (!isZernioId(accountId)) throw new ZernioScopeError("The connection result named no valid Zernio account.");
  const docs = await liveProfileAccounts(scope);
  const doc = docs.find((d) => d._id === accountId);
  if (!doc) throw new ZernioScopeError("That account is not on this workspace's Zernio profile, so it was not recorded.");
  await syncZernioAccounts(scope);
  const row = await mirroredAccount(scope, accountId);
  if (!row) throw new ZernioScopeError("The account could not be recorded.");
  return row;
}

/**
 * An account this workspace may act on. Refused with no HTTP call when it is
 * not in the workspace's mirror (another workspace's account, a made-up id);
 * otherwise confirmed live on our profile.
 */
export async function requireOwnedAccount(
  scope: ZernioScope,
  accountId: unknown,
  opts: { category?: "ads" | "social" } = {},
): Promise<ZernioAccountRow> {
  const id = typeof accountId === "string" ? accountId.trim() : "";
  const row = id ? await mirroredAccount(scope, id) : null;
  if (!row || row.status === "disconnected") {
    throw new ZernioScopeError(`Zernio account "${id.slice(0, 40)}" is not connected to this workspace — refusing.`);
  }
  if (opts.category === "ads" && row.category !== "ads") {
    throw new ZernioScopeError(`Zernio account "${id}" is not an ads connection — use an ads account (Settings → Connectors → Zernio → Connect ad account).`);
  }
  const live = await liveProfileAccounts(scope);
  if (!live.some((d) => d._id === id && d.isActive)) {
    await withWorkspaceScope(scope.workspaceId, (tx) =>
      tx.zernioAccount.update({ where: { id: row.id, workspaceId: scope.workspaceId }, data: { status: "disconnected", disconnectedAt: new Date() } }),
    );
    throw new ZernioScopeError(`Zernio account "${id}" is no longer connected to this workspace's profile — refusing.`);
  }
  return row;
}

/** A platform ad account (act_…, customer id …) listed under an owned ads account. */
export async function requireOwnedAdAccount(scope: ZernioScope, account: ZernioAccountRow, adAccountId: unknown): Promise<string> {
  const id = typeof adAccountId === "string" ? adAccountId.trim() : "";
  if (!id || id.length > 64 || !/^[\w-]+$/.test(id)) throw new ZernioScopeError("A platform ad account id is required.");
  const listed = (await scope.client.listAdAccounts({ accountId: account.accountId })).map((a) => a.id);
  await withWorkspaceScope(scope.workspaceId, (tx) =>
    tx.zernioAccount.update({ where: { id: account.id, workspaceId: scope.workspaceId }, data: { adAccountIds: listed } }),
  );
  if (!listed.includes(id)) {
    throw new ZernioScopeError(`Ad account "${id}" is not under this workspace's Zernio ads connection — refusing.`);
  }
  return id;
}

/**
 * A campaign on this workspace's profile: GET /v1/ads/campaigns?profileId=<ours>&campaignId=<id>
 * must return it, under an account in our mirror.
 */
export async function requireOwnedCampaign(scope: ZernioScope, campaignId: unknown, platform?: unknown): Promise<ZernioCampaignDoc> {
  const id = typeof campaignId === "string" ? campaignId.trim() : typeof campaignId === "number" ? String(campaignId) : "";
  if (!id || id.length > 64 || !/^[\w~-]+$/.test(id)) throw new ZernioScopeError("A platform campaign id is required.");
  const plat = typeof platform === "string" && platform ? platform : undefined;
  const found = (await scope.client.listAdCampaigns({ profileId: scope.profileId, campaignId: id, platform: plat })).filter(
    (c) => c.platformCampaignId === id && (!c.profileId || c.profileId === scope.profileId),
  );
  if (found.length === 0) throw new ZernioScopeError(`Campaign "${id}" is not on this workspace's Zernio profile — refusing.`);
  if (found.length > 1 && !plat) throw new ZernioScopeError(`Campaign "${id}" exists on more than one platform — say which platform.`);
  const c = found[0]!;
  if (c.accountId) {
    const row = await mirroredAccount(scope, c.accountId);
    if (!row) throw new ZernioScopeError(`Campaign "${id}" belongs to an account that is not this workspace's — refusing.`);
  }
  return c;
}

/** Workspace accounts from the mirror only (no HTTP) — for metering fallbacks and the usage page. */
export async function mirroredAccounts(workspaceId: string, mode: "live" | "mock"): Promise<ZernioAccountRow[]> {
  return withWorkspaceScope(workspaceId, async (tx) => {
    const profile = await tx.zernioProfile.findUnique({ where: { workspaceId_mode: { workspaceId, mode } } });
    if (!profile) return [];
    return tx.zernioAccount.findMany({ where: { workspaceId, profileRowId: profile.id } });
  });
}

export function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
}
