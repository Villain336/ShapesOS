// ShapesOS — workspace lifecycle: create, rename, delete (Phase 3, workstream I).
//
//   create  any signed-in user (capped per owner). The plan follows
//           DEPLOYMENT_MODE (lib/billing/trial.ts): self_hosted, or on a
//           hosted deployment the user's one 14-day trial — later workspaces
//           start on an already-ended trial and need a plan for metered work.
//   rename  admin+ of the workspace.
//   delete  owner only, with the workspace name typed back exactly. Refused
//           while a paid subscription is still live, and for the user's last
//           workspace. Children go with the workspace (ON DELETE CASCADE);
//           the handful of ON DELETE RESTRICT links between children are
//           cleared first, in dependency order, inside the same transaction.
//
// Every change is audited in workspace_lifecycle_events (no FK, so the
// record of a deletion survives it); create and rename also land in the
// workspace's own audit log (file_change_log).

import type { Prisma, Workspace, WorkspaceRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getMembership, roleAtLeast } from "@/lib/authz";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/api/errors";
import { deploymentMode, initialPlanFor } from "@/lib/billing/trial";
import { WORKSPACE_GUC } from "@/lib/substrate/memory/rls";

export const MAX_WORKSPACE_NAME = 80;
/** Workspaces one user may own (abuse ceiling, not a plan entitlement). */
export const MAX_OWNED_WORKSPACES = 25;

type Tx = Prisma.TransactionClient;

// ── Pure rules (unit-tested) ────────────────────────────────────────────────

/** Trimmed, collapsed workspace name; throws BadRequestError when unusable. */
export function normalizeWorkspaceName(raw: unknown): string {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  if (!name) throw new BadRequestError("Give the workspace a name.");
  if (name.length > MAX_WORKSPACE_NAME) {
    throw new BadRequestError(`Keep the name under ${MAX_WORKSPACE_NAME} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new BadRequestError("The name has characters that can't be shown.");
  return name;
}

export function canRenameWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return roleAtLeast(role, "admin");
}

export function canDeleteWorkspace(role: WorkspaceRole | null | undefined): boolean {
  return role === "owner";
}

/** The typed confirmation must be the workspace's name, exactly (surrounding spaces ignored). */
export function deleteConfirmationMatches(typed: unknown, workspaceName: string): boolean {
  return typeof typed === "string" && typed.trim() === workspaceName.trim() && typed.trim().length > 0;
}

/** Subscription states that still bill (or will retry billing) the workspace. */
export const LIVE_SUBSCRIPTION = new Set(["active", "trialing", "past_due", "unpaid", "incomplete"]);

/**
 * Why this delete is refused, or null when it may go ahead. Checked in
 * order: role, confirmation, last workspace, live subscription.
 */
export function deleteWorkspaceError(opts: {
  role: WorkspaceRole | null | undefined;
  typedName: unknown;
  workspaceName: string;
  accessibleCount: number;
  subscription: { status: string; cancelAtPeriodEnd: boolean } | null;
}): { status: 400 | 403 | 409; message: string } | null {
  if (!canDeleteWorkspace(opts.role)) {
    return { status: 403, message: "Only a workspace owner can delete it." };
  }
  if (!deleteConfirmationMatches(opts.typedName, opts.workspaceName)) {
    return { status: 400, message: "Type the workspace name exactly to confirm." };
  }
  if (opts.accessibleCount <= 1) {
    return { status: 409, message: "This is your only workspace. Create or join another one before deleting it." };
  }
  const sub = opts.subscription;
  if (sub && LIVE_SUBSCRIPTION.has(sub.status) && !sub.cancelAtPeriodEnd) {
    return { status: 409, message: "This workspace still has a paid subscription. Cancel it in Billing first." };
  }
  return null;
}

// ── Audit ────────────────────────────────────────────────────────────────────

async function lifecycleEvent(
  tx: Tx,
  e: { workspaceId: string; workspaceName: string; actorUserId: string; action: "created" | "renamed" | "deleted"; detail: Prisma.InputJsonObject },
) {
  await tx.workspaceLifecycleEvent.create({ data: e });
}

/** Has this user already been given a hosted trial (any workspace, deleted ones included)? */
export async function hasHadTrial(userId: string, tx: Tx | typeof prisma = prisma): Promise<boolean> {
  const n = await tx.workspaceLifecycleEvent.count({
    where: { actorUserId: userId, action: "created", detail: { path: ["trial"], equals: true } },
  });
  return n > 0;
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * True when the account was deleted (GDPR) at or after the session's sign-in
 * — i.e. the caller is a session that outlived its account. Sessions without
 * a sign-in time (minted before Phase 4a) count as older.
 */
export async function deletedBeforeSignIn(
  db: Pick<Prisma.TransactionClient, "userSecurity">,
  userId: string,
  authAt: number | null | undefined,
): Promise<boolean> {
  const row = await db.userSecurity.findUnique({ where: { userId }, select: { accountDeletedAt: true } });
  if (!row?.accountDeletedAt) return false;
  return !(typeof authAt === "number" && authAt * 1000 > row.accountDeletedAt.getTime());
}

/**
 * Create a workspace owned by `userId` (with its `owner` membership row).
 * Serialized per user (advisory lock) so two concurrent signups can't both
 * claim the one free trial. The new workspace starts the onboarding wizard.
 */
export async function createWorkspaceForUser(opts: {
  userId: string;
  name: unknown;
  env?: NodeJS.ProcessEnv;
  now?: Date;
  /**
   * Signup provisioning: return the user's existing workspace instead when
   * they already have one (two first page loads racing each other).
   */
  ifNoneExists?: boolean;
  /**
   * Unix seconds the caller's session signed in (session.user.authAt). A
   * deleted account's older sessions must not provision a fresh workspace;
   * signing in again afterwards starts over.
   */
  authAt?: number | null;
}): Promise<Workspace> {
  const name = normalizeWorkspaceName(opts.name);
  const now = opts.now ?? new Date();
  const mode = deploymentMode(opts.env);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtext(${`workspace-create:${opts.userId}`}))`;
    if (await deletedBeforeSignIn(tx, opts.userId, opts.authAt)) {
      throw new UnauthorizedError("This account was deleted. Sign in again to start over.");
    }
    if (opts.ifNoneExists) {
      const existing = await tx.workspace.findFirst({
        where: { OR: [{ ownerUserId: opts.userId }, { members: { some: { userId: opts.userId } } }] },
        orderBy: { createdAt: "desc" },
      });
      if (existing) return existing;
    }
    const owned = await tx.workspace.count({ where: { ownerUserId: opts.userId } });
    if (owned >= MAX_OWNED_WORKSPACES) {
      throw new ConflictError(`You already own ${MAX_OWNED_WORKSPACES} workspaces. Delete one to make room.`);
    }
    const hadTrial = mode === "hosted" ? await hasHadTrial(opts.userId, tx) : false;
    const { plan, trialEndsAt } = initialPlanFor({ mode, hadTrial, now });
    const workspace = await tx.workspace.create({
      data: {
        name,
        ownerUserId: opts.userId,
        plan,
        trialEndsAt,
        members: { create: { userId: opts.userId, role: "owner" } },
      },
    });
    const trialStarted = plan === "trial" && !!trialEndsAt && trialEndsAt > now;
    await lifecycleEvent(tx, {
      workspaceId: workspace.id,
      workspaceName: name,
      actorUserId: opts.userId,
      action: "created",
      detail: { plan, trial: trialStarted, deploymentMode: mode, ...(trialEndsAt ? { trialEndsAt: trialEndsAt.toISOString() } : {}) },
    });
    await tx.fileChangeLog.create({
      data: {
        workspaceId: workspace.id,
        filePath: "(workspace)",
        actor: "user",
        action: "workspace_created",
        summary: `Workspace "${name}" created on the ${plan} plan`,
        approvedBy: opts.userId,
      },
    });
    return workspace;
  });
}

// ── Rename ───────────────────────────────────────────────────────────────────

export async function renameWorkspace(opts: {
  userId: string;
  workspaceId: string;
  name: unknown;
}): Promise<Workspace> {
  const me = await getMembership(opts.userId, opts.workspaceId);
  if (!me) throw new NotFoundError("Workspace not found.");
  if (!canRenameWorkspace(me.role)) throw new ForbiddenError("Renaming a workspace needs the admin role.");
  const name = normalizeWorkspaceName(opts.name);
  return prisma.$transaction(async (tx) => {
    const prev = await tx.workspace.findUnique({ where: { id: opts.workspaceId }, select: { name: true } });
    if (!prev) throw new NotFoundError("Workspace not found.");
    const workspace = await tx.workspace.update({ where: { id: opts.workspaceId }, data: { name } });
    if (prev.name !== name) {
      await lifecycleEvent(tx, {
        workspaceId: opts.workspaceId,
        workspaceName: name,
        actorUserId: opts.userId,
        action: "renamed",
        detail: { from: prev.name, to: name },
      });
      await tx.fileChangeLog.create({
        data: {
          workspaceId: opts.workspaceId,
          filePath: "(workspace)",
          actor: "user",
          action: "workspace_renamed",
          summary: `Workspace renamed from "${prev.name}" to "${name}"`,
          approvedBy: opts.userId,
        },
      });
    }
    return workspace;
  });
}

// ── Delete ───────────────────────────────────────────────────────────────────

/**
 * ON DELETE RESTRICT links between a workspace's own rows. RESTRICT is
 * checked immediately, so if the cascade reaches the parent first the whole
 * delete fails; these children are removed first, in dependency order.
 * lib/workspace/__tests__/lifecycle-db.test.ts fails when a migration adds a
 * RESTRICT foreign key that isn't listed here.
 */
export const RESTRICT_CHILD_CLEANUP: { fk: string; sql: string }[] = [
  { fk: "newsletter_broadcasts_list_id_fkey", sql: `DELETE FROM "newsletter_broadcasts" WHERE "project_id" IN (SELECT "id" FROM "projects" WHERE "workspace_id" = $1)` },
  { fk: "newsletter_broadcasts_domain_id_fkey", sql: `DELETE FROM "newsletter_broadcasts" WHERE "domain_id" IN (SELECT "id" FROM "newsletter_domains" WHERE "workspace_id" = $1)` },
  { fk: "policy_decisions_proposal_id_fkey", sql: `DELETE FROM "policy_decisions" WHERE "workspace_id" = $1` },
  { fk: "call_sessions_agent_id_fkey", sql: `DELETE FROM "call_sessions" WHERE "workspace_id" = $1` },
  { fk: "wfh_expenses_category_id_fkey", sql: `DELETE FROM "wfh_expenses" WHERE "workspace_id" = $1` },
  { fk: "insurance_certificates_policy_id_fkey", sql: `DELETE FROM "insurance_certificates" WHERE "workspace_id" = $1` },
  { fk: "insurance_policies_carrier_id_fkey", sql: `DELETE FROM "insurance_policies" WHERE "workspace_id" = $1` },
  { fk: "cad_cost_estimates_bom_version_id_fkey", sql: `DELETE FROM "cad_cost_estimates" WHERE "workspace_id" = $1` },
  { fk: "cad_cost_estimates_rate_card_id_fkey", sql: `DELETE FROM "cad_cost_estimates" WHERE "workspace_id" = $1` },
];

export async function deleteWorkspace(opts: {
  userId: string;
  workspaceId: string;
  confirmName: unknown;
}): Promise<{ deletedId: string; name: string }> {
  const me = await getMembership(opts.userId, opts.workspaceId);
  if (!me) throw new NotFoundError("Workspace not found.");
  const ws = await prisma.workspace.findUnique({
    where: { id: opts.workspaceId },
    select: { id: true, name: true, plan: true },
  });
  if (!ws) throw new NotFoundError("Workspace not found.");
  const [accessibleCount, subscription] = await Promise.all([
    prisma.workspace.count({
      where: { OR: [{ ownerUserId: opts.userId }, { members: { some: { userId: opts.userId } } }] },
    }),
    readSubscription(opts.workspaceId),
  ]);
  const denial = deleteWorkspaceError({
    role: me.role,
    typedName: opts.confirmName,
    workspaceName: ws.name,
    accessibleCount,
    subscription,
  });
  if (denial) {
    if (denial.status === 403) throw new ForbiddenError(denial.message);
    if (denial.status === 409) throw new ConflictError(denial.message);
    throw new BadRequestError(denial.message);
  }

  await purgeWorkspace({
    workspaceId: ws.id,
    workspaceName: ws.name,
    actorUserId: opts.userId,
    detail: { plan: ws.plan, role: me.role },
  });
  return { deletedId: ws.id, name: ws.name };
}

/**
 * Tables with a workspace_id that deliberately survive the workspace's
 * deletion. Every other such table has a foreign key to workspaces with ON
 * DELETE CASCADE (migration 20261005100000_phase4a_workspace_orphan_fks);
 * lib/workspace/__tests__/workspace-orphans-db.test.ts derives the table list
 * from the catalog and fails on a new table that has neither.
 */
export const KEEP_ON_WORKSPACE_DELETE: readonly string[] = [
  // The audit record of the deletion itself (who, when, which plan).
  "workspace_lifecycle_events",
];

/**
 * The delete itself, once every rule has passed: lock the row, clear the
 * ON DELETE RESTRICT children, delete the workspace (everything else
 * cascades) and record it in the lifecycle trail. Shared by deleteWorkspace
 * and account deletion (lib/account/delete.ts), which checks its own rules.
 */
export async function purgeWorkspace(opts: {
  workspaceId: string;
  workspaceName: string;
  actorUserId: string;
  detail: Prisma.InputJsonObject;
}): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      // Lock the row so a concurrent rename/delete can't interleave.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "workspaces" WHERE "id" = ${opts.workspaceId} FOR UPDATE`;
      if (locked.length === 0) throw new NotFoundError("Workspace not found.");
      // Tenant GUC for the RLS-protected tables cleared explicitly below.
      await tx.$queryRaw`SELECT set_config(${WORKSPACE_GUC}, ${opts.workspaceId}, true)`;
      for (const step of RESTRICT_CHILD_CLEANUP) {
        await tx.$executeRawUnsafe(step.sql, opts.workspaceId);
      }
      await tx.workspace.delete({ where: { id: opts.workspaceId } });
      await lifecycleEvent(tx, {
        workspaceId: opts.workspaceId,
        workspaceName: opts.workspaceName,
        actorUserId: opts.actorUserId,
        action: "deleted",
        detail: opts.detail,
      });
    },
    { maxWait: 10_000, timeout: 120_000 },
  );
}

/**
 * The workspace's Stripe subscription row. billing_subscriptions is created
 * lazily by lib/metering/billing.ts the first time billing runs, so on an
 * install that never billed it doesn't exist: that (and only that) reads as
 * "no subscription". Any other failure refuses the delete.
 */
export async function readSubscription(
  workspaceId: string,
): Promise<{ status: string; cancelAtPeriodEnd: boolean } | null> {
  try {
    const rows = await prisma.$queryRaw<{ status: string; cancel_at_period_end: boolean }[]>`
      SELECT status, cancel_at_period_end FROM billing_subscriptions WHERE workspace_id = ${workspaceId} LIMIT 1`;
    const r = rows[0];
    return r ? { status: r.status, cancelAtPeriodEnd: r.cancel_at_period_end } : null;
  } catch (err) {
    const code =
      (err as { meta?: { code?: string } })?.meta?.code ?? (err as { code?: string })?.code;
    if (code === "42P01" || /billing_subscriptions.*does not exist/.test(String(err))) return null;
    throw err;
  }
}
