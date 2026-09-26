// Marketr — alert event history page (milestone 13).
// Any workspace member can view; retry is editor+ (API-enforced).

import { redirect } from "next/navigation";
import { requireUser, getOrCreateWorkspace } from "@/lib/session";
import { requireWorkspaceRole, roleAtLeast } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { TRIGGERS } from "@/lib/alerts/triggers";
import AlertHistory from "@/components/AlertHistory";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const user = await requireUser();
  if (!user) redirect("/login");
  const workspace = await getOrCreateWorkspace(user.id, user.email);
  const membership = await requireWorkspaceRole(user.id, workspace.id, "viewer");
  if (!membership) redirect("/dashboard");

  const [events, rules] = await Promise.all([
    prisma.alertEvent.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: { rule: { select: { id: true, name: true } } },
    }),
    prisma.alertRule.findMany({
      where: { workspaceId: workspace.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-bold tracking-tight text-ink">Alert history</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Every alert the hub sent, queued, or suppressed — with per-channel delivery results.
        </p>
      </div>
      <AlertHistory
        initial={events.map((e) => ({
          id: e.id,
          ruleId: e.ruleId,
          ruleName: e.rule.name,
          trigger: e.trigger,
          triggerLabel: TRIGGERS.find((t) => t.key === e.trigger)?.label ?? e.trigger,
          title: e.title,
          body: e.body,
          link: e.link,
          queueReason: e.queueReason,
          status: e.status,
          results: (e.results as unknown[]) ?? [],
          retryCount: e.retryCount,
          createdAt: e.createdAt.toISOString(),
          sentAt: e.sentAt?.toISOString() ?? null,
        }))}
        rules={rules}
        canRetry={roleAtLeast(membership.role, "editor")}
      />
    </div>
  );
}
