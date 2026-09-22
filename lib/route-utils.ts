// Marketr — shared helpers for milestone 21 API routes.
//
// Two-step access pattern (404 for "not your workspace/project", 403 for
// "your role is too low"), workspaceId extraction, and the skillMd-stripping
// serializer. Secrets are never serialized here.

import type { NextRequest } from "next/server";
import { prisma } from "./prisma";
import {
  accessibleWorkspaceWhere,
  getMembership,
  roleAtLeast,
  forbidden,
} from "./authz";
import type { Skill, WorkspaceRole } from "@prisma/client";

export { forbidden };

/** workspaceId from a JSON body or the ?workspaceId= query param. */
export function workspaceIdFrom(
  req: NextRequest,
  body?: { workspaceId?: unknown } | null,
): string | null {
  const fromBody =
    body && typeof body.workspaceId === "string" && body.workspaceId.trim()
      ? body.workspaceId.trim()
      : null;
  if (fromBody) return fromBody;
  const q = req.nextUrl.searchParams.get("workspaceId")?.trim();
  return q ? q : null;
}

export function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 });
}

export function notFound(message = "Not found") {
  return Response.json({ error: message }, { status: 404 });
}

/**
 * Workspace access: 404 when the workspace isn't accessible to the user,
 * 403 when the role is too low. Returns { workspaceId, membership }.
 */
export async function requireWorkspaceAccess(
  userId: string,
  workspaceId: string | null,
  min: WorkspaceRole,
) {
  if (!workspaceId) return { error: badRequest("workspaceId is required") };
  const workspace = await prisma.workspace.findFirst({
    where: { id: workspaceId, AND: [accessibleWorkspaceWhere(userId)] },
    select: { id: true },
  });
  if (!workspace) return { error: notFound("Workspace not found") };
  const membership = await getMembership(userId, workspaceId);
  if (!membership || !roleAtLeast(membership.role, min)) {
    return { error: forbidden() };
  }
  return { workspaceId, membership };
}

/**
 * Project access: 404 when the project isn't accessible to the user,
 * 403 when the role is too low. Returns { project, membership }.
 */
export async function requireProjectAccess(
  userId: string,
  projectId: string,
  min: WorkspaceRole,
) {
  const project = await prisma.project.findFirst({
    where: { id: projectId, workspace: accessibleWorkspaceWhere(userId) },
    select: { id: true, workspaceId: true },
  });
  if (!project) return { error: notFound("Project not found") };
  const membership = await getMembership(userId, project.workspaceId);
  if (!membership || !roleAtLeast(membership.role, min)) {
    return { error: forbidden() };
  }
  return { project, membership };
}

/** Serialize a Skill row without its skillMd body (never sent in lists). */
export function publicSkill(s: Skill) {
  return {
    id: s.id,
    workspaceId: s.workspaceId,
    name: s.name,
    slug: s.slug,
    description: s.description,
    source: s.source,
    sourceRef: s.sourceRef,
    version: s.version,
    shaPin: s.shaPin,
    declaredTools: s.declaredTools,
    trustTier: s.trustTier,
    installedBy: s.installedBy,
    installedAt: s.installedAt.toISOString(),
  };
}
