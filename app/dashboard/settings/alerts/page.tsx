// Marketr — alert hub settings page (milestone 13).
// Editor+ only (server-gated); viewers are redirected to the dashboard.
// Channel writes are admin+ (enforced in the API and hidden in the UI).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { TRIGGERS } from "@/lib/alerts/triggers";
import AlertManager from "@/components/AlertManager";

export const dynamic = "force-dynamic";

export default async function AlertsSettingsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "editor");
  if (!membership) redirect("/dashboard");

  const [channels, rules, projects] = await Promise.all([
    prisma.alertChannel.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
      include: { _count: { select: { rules: true } } },
    }),
    prisma.alertRule.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "asc" },
      include: {
        channels: { select: { id: true, name: true, type: true, hint: true, enabled: true } },
        _count: { select: { events: true } },
      },
    }),
    prisma.project.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { domain: "asc" },
      select: { id: true, domain: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Alerts</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Rules watch for rank drops, AI Overview changes, fix-agent runs and report completions —
          then notify Slack, Telegram, or email. Cooldowns keep it quiet.
        </p>
      </div>
      <AlertManager
        initialChannels={channels.map((c) => ({
          id: c.id,
          name: c.name,
          type: c.type,
          hint: c.hint,
          enabled: c.enabled,
          ruleCount: c._count.rules,
        }))}
        initialRules={rules.map((r) => ({
          id: r.id,
          name: r.name,
          trigger: r.trigger,
          triggerLabel: TRIGGERS.find((t) => t.key === r.trigger)?.label ?? r.trigger,
          conditions: (r.conditions as Record<string, unknown>) ?? {},
          cooldownSec: r.cooldownSec,
          digest: r.digest,
          quietHours: (r.quietHours as { start: string; end: string } | null) ?? null,
          enabled: r.enabled,
          lastFiredAt: r.lastFiredAt?.toISOString() ?? null,
          channels: r.channels,
          eventCount: r._count.events,
        }))}
        triggers={TRIGGERS}
        projects={projects.map((p) => ({ id: p.id, name: p.domain }))}
        canManageChannels={roleAtLeast(membership.role, "admin")}
      />
    </div>
  );
}
