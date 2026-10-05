// ShapesOS — Phase 11 (conncore): Slack app installations.
//
// recordSlackInstall() runs right after the Slack OAuth callback stored the
// bot token (lib/vault/callback.ts): it maps the Slack team to this
// workspace in slack_installations (FORCE RLS). One ShapesOS workspace per
// Slack team — a team already installed elsewhere is refused (the unique
// team_id is invisible across tenants, so the insert's conflict is the check).
//
// routeSlackTeam() is the Events API receiver's one cross-tenant read: it
// sets app.slack_route = 'lookup' for a single SELECT on slack_installations
// (the SELECT-only policy in migration 20261012200000_p11_conncore_slack).

import { prisma } from "@/lib/prisma";
import { withWorkspaceScope } from "@/lib/substrate/memory/rls";

export class SlackInstallConflictError extends Error {
  constructor() {
    super("This Slack team is already connected to another ShapesOS workspace — uninstall it there first.");
    this.name = "SlackInstallConflictError";
  }
}

function metaString(meta: unknown, key: string): string | null {
  if (!meta || typeof meta !== "object") return null;
  const v = (meta as Record<string, unknown>)[key];
  return typeof v === "string" && v ? v : null;
}

export interface SlackInstallRow {
  id: string;
  workspaceId: string;
  teamId: string;
  connectionId: string;
  installedBy: string;
  projectId: string | null;
  botUserId: string | null;
  allowedUserIds: string[];
  enabled: boolean;
}

/** Map the installing Slack team to this workspace (idempotent re-install). */
export async function recordSlackInstall(input: {
  workspaceId: string;
  userId: string;
  connectionId: string;
  meta: unknown;
}): Promise<SlackInstallRow> {
  const teamId = metaString(input.meta, "slackTeamId");
  if (!teamId || !/^[TE][A-Z0-9]{4,20}$/.test(teamId)) {
    throw new Error("Slack did not return a team id for this install.");
  }
  // Default project: the workspace's most recently active one.
  const project = await prisma.project.findFirst({
    where: { workspaceId: input.workspaceId },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
  try {
    return await withWorkspaceScope(input.workspaceId, async (tx) => {
      const existing = await tx.slackInstallation.findFirst({ where: { workspaceId: input.workspaceId, teamId } });
      const data = {
        teamName: metaString(input.meta, "slackTeamName"),
        botUserId: metaString(input.meta, "slackBotUserId"),
        connectionId: input.connectionId,
        installedBy: input.userId,
        enabled: true,
      };
      if (existing) {
        return tx.slackInstallation.update({
          where: { id: existing.id, workspaceId: input.workspaceId },
          data: { ...data, projectId: existing.projectId ?? project?.id ?? null },
        });
      }
      return tx.slackInstallation.create({
        data: { ...data, workspaceId: input.workspaceId, teamId, projectId: project?.id ?? null },
      });
    });
  } catch (err) {
    if ((err as { code?: unknown })?.code === "P2002") throw new SlackInstallConflictError();
    throw err;
  }
}

/** team_id → its installation (any workspace). The receiver's only cross-tenant read. */
export async function routeSlackTeam(teamId: string): Promise<SlackInstallRow | null> {
  if (!/^[TE][A-Z0-9]{4,20}$/.test(teamId)) return null;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL app.slack_route = 'lookup'`);
    return tx.slackInstallation.findFirst({
      where: { teamId },
      select: {
        id: true,
        workspaceId: true,
        teamId: true,
        connectionId: true,
        installedBy: true,
        projectId: true,
        botUserId: true,
        allowedUserIds: true,
        enabled: true,
      },
    });
  });
}
