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

/** Link pending email invites to a freshly signed-in user. */
export async function linkPendingInvites(userId: string, email: string) {
  const normalized = email.trim().toLowerCase();
  await prisma.workspaceMember.updateMany({
    where: { email: normalized, userId: null },
    data: { userId, email: normalized },
  });
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
 * *project creation: editor+. Project deletion: admin+.
 */
export const CAPABILITY_MATRIX = "see lib/authz.ts header";
