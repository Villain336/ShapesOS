// Marketr — workspace RBAC (milestone 11).
//
// Role hierarchy: owner > admin > editor > viewer
//   viewer — read-only (GET routes; can view dashboards, issues, deployments).
//   editor — read + write, EXCEPT member management and connection-credential
//            CRUD (SFTP/GitHub/WP/Webflow/hosting tokens stay admin+).
//   admin  — everything except workspace deletion.
//   owner  — full control.
//
// Enforcement boundary is the API layer (requireProjectRole /
// requireWorkspaceRole). Pages additionally gate the Members settings UI.
// Cron/service routes keep using CRON_SECRET bearer auth (shared service
// secret, not a user role) — see app/api/cron/fix-agent/route.ts.

import { prisma } from "./prisma";
import { randomBytes } from "node:crypto";
import type { WorkspaceMember, WorkspaceRole } from "@prisma/client";

export const ROLE_RANK: Record<WorkspaceRole, number> = {
  viewer: 1,
  editor: 2,
  admin: 3,
  owner: 4,
};

export function roleAtLeast(role: WorkspaceRole | null | undefined, min: WorkspaceRole): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Prisma where-clause: workspaces the user can access (owner or member). */
export function accessibleWorkspaceWhere(userId: string) {
  return {
    OR: [{ ownerUserId: userId }, { members: { some: { userId } } }],
  };
}

/**
 * Load the user's membership for a workspace, lazily backfilling an `owner`
 * row for legacy workspaces whose ownerUserId matches (pre-m11 data).
 */
export async function getMembership(
  userId: string,
  workspaceId: string,
): Promise<WorkspaceMember | null> {
  const existing = await prisma.workspaceMember.findFirst({
    where: { workspaceId, userId },
  });
  if (existing) return existing;
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { ownerUserId: true },
  });
  if (workspace?.ownerUserId === userId) {
    return prisma.workspaceMember.create({
      data: { workspaceId, userId, role: "owner" },
    });
  }
  return null;
}

/**
 * Claim a pending workspace invite via its single-use token (day-1
 * hardening, M5). Replaces the old bare-email-match auto-linking: the token
 * is the capability, and the invite's email must still match the claimant's
 * sign-in email so a leaked token can't be sprayed across accounts.
 * Returns the claimed membership, or null when the token is unknown,
 * expired, already used, or addressed to a different email.
 */
export async function claimInviteToken(
  userId: string,
  email: string,
  token: string,
): Promise<WorkspaceMember | null> {
  const normalized = email.trim().toLowerCase();
  const cleanToken = token.trim();
  if (!cleanToken || !normalized) return null;
  const pending = await prisma.workspaceMember.findFirst({
    where: { inviteToken: cleanToken, userId: null },
  });
  if (!pending) return null;
  if (pending.inviteExpiresAt && pending.inviteExpiresAt < new Date()) return null;
  if (!pending.email || pending.email.trim().toLowerCase() !== normalized) return null;
  // Day-1: atomic single-use claim. Two concurrent claimants could both pass
  // the checks above; the updateMany re-asserts every condition in the WHERE
  // so exactly one wins (count === 1) and the loser sees count === 0.
  const claimed = await prisma.workspaceMember.updateMany({
    where: {
      id: pending.id,
      userId: null,
      inviteToken: cleanToken,
      email: { equals: normalized, mode: "insensitive" },
      OR: [{ inviteExpiresAt: null }, { inviteExpiresAt: { gte: new Date() } }],
    },
    data: { userId, inviteToken: null, inviteExpiresAt: null },
  });
  if (claimed.count === 0) return null; // lost the race — token already spent
  // Privilege-grant event (M8: invite acceptance must be audited).
  await prisma.fileChangeLog.create({
    data: {
      projectId: null,
      workspaceId: pending.workspaceId,
      filePath: "(workspace)",
      actor: "user",
      action: "member_invite_accepted",
      summary: `${normalized} accepted invite as ${pending.role}`,
      approvedBy: userId,
    },
  });
  return { ...pending, userId, inviteToken: null, inviteExpiresAt: null };
}

/** Mint a single-use invite token (128-bit) with a 7-day expiry. */
export function mintInviteToken(): { inviteToken: string; inviteExpiresAt: Date } {
  return {
    inviteToken: randomBytes(32).toString("hex"),
    inviteExpiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
  };
}

/** Require at least `min` role on a workspace. Returns the membership or null. */
export async function requireWorkspaceRole(
  userId: string,
  workspaceId: string,
  min: WorkspaceRole,
): Promise<WorkspaceMember | null> {
  const m = await getMembership(userId, workspaceId);
  if (!m || !roleAtLeast(m.role, min)) return null;
  return m;
}

/**
 * Granular permission grants (milestone 21, spec §7). Owner/admin always
 * hold every permission; PermissionGrant rows extend specific permissions
 * to individual users or to every member at/above a role.
 */
export type GrantablePermission = "skills.install" | "connectors.connect";

/** True when the user holds `permission` (string kept open for future grants). */
export async function hasPermission(
  userId: string,
  workspaceId: string,
  permission: string,
): Promise<boolean> {
  const m = await getMembership(userId, workspaceId);
  if (!m) return false;
  if (roleAtLeast(m.role, "admin")) return true;
  const grants = await prisma.permissionGrant.findMany({
    where: { workspaceId, permission },
  });
  for (const g of grants) {
    if (g.userId && g.userId === userId) return true;
    if (g.role && roleAtLeast(m.role, g.role)) return true;
  }
  return false;
}

/**
 * Require a granted permission on a workspace. Returns the membership or
 * null (null when there is no membership, or no membership with the grant).
 */
export async function requirePermission(
  userId: string,
  workspaceId: string,
  permission: string,
): Promise<WorkspaceMember | null> {
  const m = await getMembership(userId, workspaceId);
  if (!m) return null;
  if (!(await hasPermission(userId, workspaceId, permission))) return null;
  return m;
}

/** Resolve a project → its workspace id. */
export async function workspaceIdForProject(projectId: string): Promise<string | null> {
  const p = await prisma.project.findUnique({
    where: { id: projectId },
    select: { workspaceId: true },
  });
  return p?.workspaceId ?? null;
}

/**
 * Require at least `min` role on the workspace owning `projectId`.
 * Returns { project, membership } or null (caller maps to 404/403).
 */
export async function requireProjectRole(
  userId: string,
  projectId: unknown,
  min: WorkspaceRole,
): Promise<{ project: { id: string; workspaceId: string }; membership: WorkspaceMember } | null> {
  if (typeof projectId !== "string" || !projectId) return null;
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
  if (!project) return null;
  const membership = await getMembership(userId, project.workspaceId);
  if (!membership || !roleAtLeast(membership.role, min)) return null;
  return { project, membership };
}

/** Standard 403 for RBAC denials (distinct from 401 unauthenticated). */
export function forbidden(message = "Insufficient role for this action.") {
  return Response.json({ error: message }, { status: 403 });
}

/**
 * Capability matrix (also enforced per-route; this is the reference):
 *
 * | action                              | viewer | editor | admin | owner |
 * |-------------------------------------|--------|--------|-------|-------|
 * | read dashboards / lists / issues    |   ✓    |   ✓    |   ✓   |   ✓   |
 * | keyword/content/competitor writes    |        |   ✓    |   ✓   |   ✓   |
 * | run audit / approve issues / apply   |        |   ✓    |   ✓   |   ✓   |
 * | deploy (hosting/SFTP/GitHub/WP)     |        |   ✓    |   ✓   |   ✓   |
 * | create/delete projects              |        |   ✓*   |   ✓   |   ✓   |
 * | connection credential CRUD          |        |        |   ✓   |   ✓   |
 * | fix-agent settings                  |        |        |   ✓   |   ✓   |
 * | member add / role change / remove   |        |        |   ✓   |   ✓   |
 * | workspace deletion                  |        |        |       |   ✓   |
 *
 * M21 permission grants (spec §7) — assigned per user or per role, managed
 * at /api/members/grants; owner/admin hold every grant by default:
 * | skills.install (install / re-pin / uninstall skills)    | grant-only | grant-only | ✓ | ✓ |
 * | connectors.connect (OAuth/API-key connect, add MCP)     | grant-only | grant-only | ✓ | ✓ |
 * | data-source bind, project skill toggles                 |            |   ✓      | ✓ | ✓ |
 * | grants CRUD                                             |            |            | ✓ | ✓ |
 *
 * *project creation: editor+. Project deletion: admin+.
 */
export const CAPABILITY_MATRIX = "see lib/authz.ts header";
