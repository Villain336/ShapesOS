// ShapesOS — the widget desktop, now at /dashboard/desktop (WS=desk).
//
// Home (/dashboard) is the flat Feed; this is the arrangeable grid of
// widgets the member had there before — the lead agent with its sub-agents
// (DESIGN.md "one lead, many sub-agents"), live activity, missions and
// schedules, the attention queue, projects, "win this week" — plus Needs
// you, running agents, today's calendar, the inbox, the pipeline, cash,
// twin KPIs and the agent-written Today briefing. Only the placed widgets
// load (in parallel, lib/desktop/loaders.server.ts); a widget whose source
// fails shows its own error and the rest still renders. Layout per member
// per workspace, default per role (lib/desktop/layout.ts) — layouts are
// keyed member + workspace, not route, so the move keeps every layout.

import { redirect } from "next/navigation";
import { Clock } from "lucide-react";
import { getOrCreateWorkspace, requireUser } from "@/lib/session";
import { getMembership } from "@/lib/authz";
import { needsOnboarding } from "@/lib/workspace/onboarding";
import { providerStatus } from "@/lib/providers";
import { ValuePill } from "@/components/vault/atoms/ValuePill";
import { safeAgentActivity } from "@/lib/aos/activity.server";
import { deriveBanners, failedWorkFromTree, type FailedWork } from "@/lib/aos/home";
import { loadInbox, resolveInboxViewer } from "@/lib/approvals/inbox";
import { Banner } from "@/components/aos";
import { NewTaskButton } from "@/components/command-bar/NewTaskButton";
import { getDesk } from "@/lib/desktop/store.server";
import { getUserPreferences } from "@/lib/desktop/prefs";
import { loadWidgets, timeAgo } from "@/lib/desktop/loaders.server";
import { renderWidget } from "@/components/desktop/widgets/views";
import { Desktop } from "@/components/desktop/Desktop";
import type { WidgetId } from "@/lib/desktop/widgets";
import { DEFAULT_TIME_ZONE } from "@/lib/time/zoned";
import { prisma } from "@/lib/prisma";
// Phase 18.1 (integration): Home in the person's language (lib/i18n).
import { getI18n } from "@/lib/i18n/server";
import type { InboxSourceKey } from "@/lib/approvals/types";

export const dynamic = "force-dynamic";

/** Approvals waiting on this member, grouped by queue (best effort), queue names translated. */
async function approvalsSummary(userId: string, workspaceId: string, sourceLabel: (source: InboxSourceKey, fallback: string) => string) {
  try {
    const viewer = await resolveInboxViewer(userId, workspaceId);
    if (!viewer) return { actionable: 0, sources: [] as string[] };
    const inbox = await loadInbox(viewer, { limitPerSource: 25 });
    return {
      actionable: inbox.actionable,
      sources: inbox.sources.filter((s) => s.actionable > 0).map((s) => sourceLabel(s.source, s.label)),
    };
  } catch {
    return { actionable: 0, sources: [] as string[] };
  }
}

export default async function DashboardPage() {
  const user = await requireUser();
  if (!user) return null; // layout already redirects

  const workspace = await getOrCreateWorkspace(user.id, user.email);
  // Phase 3: a brand-new workspace opens on first-run setup, once (admins only).
  const me = await getMembership(user.id, workspace.id);
  if (needsOnboarding(workspace, me?.role)) redirect("/dashboard/welcome");
  const role = me?.role ?? "viewer";
  const now = new Date();
  const { t, locale } = await getI18n();
  const sourceLabel = (source: InboxSourceKey, fallback: string) => {
    const label = t(`approvals.sources.${source}`);
    return label === `approvals.sources.${source}` ? fallback : label;
  };

  const [desk, prefs, activity, approvals] = await Promise.all([
    getDesk(workspace.id, user.id, role),
    getUserPreferences(user.id).catch(() => ({ timeZone: null })),
    safeAgentActivity(workspace.id),
    approvalsSummary(user.id, workspace.id, sourceLabel),
  ]);
  const placed = desk.layout.widgets.map((w) => w.widget);
  const [results, lastRun] = await Promise.all([
    loadWidgets(
      { workspaceId: workspace.id, userId: user.id, role, now, timeZone: prefs.timeZone ?? DEFAULT_TIME_ZONE, workspaceName: workspace.name, t, locale },
      placed,
    ),
    prisma.workflowRun.findFirst({
      where: { workflow: { project: { workspaceId: workspace.id } } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, workflow: { select: { name: true } } },
    }).catch(() => null),
  ]);
  const contents: Partial<Record<WidgetId, React.ReactNode>> = {};
  for (const id of placed) contents[id] = renderWidget(id, results[id] as never, { t, locale });

  // ── banners: only when something needs the member ──────────
  const tree = activity?.tree ?? null;
  const failedSchedules: FailedWork[] = (activity?.schedules ?? [])
    .filter((s) => s.status === "failed")
    .map((s) => ({ key: `schedule:${s.id}`, name: s.name, detail: s.error ?? t("home.banners.scheduleFailed"), href: s.href }));
  const banners = deriveBanners({ approvals, failed: [...failedWorkFromTree(tree), ...failedSchedules] }, t);
  const provider = providerStatus();

  return (
    <div className="flex flex-col gap-6">
      {/* Page headline */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="aos-heading">{workspace.name}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted">
            <span>{t("home.plan")}</span>
            <ValuePill>{workspace.plan}</ValuePill>
            <span aria-hidden className="text-subtle">·</span>
            <span>{t("home.data")}</span>
            <ValuePill>{provider.isLive ? t("home.dataLive") : t("home.dataMock")}</ValuePill>
            {lastRun ? (
              <>
                <span aria-hidden className="text-subtle">·</span>
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3.5" aria-hidden />
                  {t("home.lastAutomation", { name: lastRun.workflow.name, ago: timeAgo(lastRun.startedAt, now, locale) })}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <NewTaskButton />
      </div>

      {banners.length ? (
        <div className="flex flex-col gap-2.5" aria-label={t("home.attention")}>
          {banners.map((b) => (
            <Banner
              key={b.key}
              status={b.status as "needs" | "failed"}
              statusLabel={t(`status.${b.status as "needs" | "failed"}`)}
              title={b.title}
              description={b.description}
              action={b.action}
            />
          ))}
        </div>
      ) : null}

      <Desktop initialLayout={desk.layout} customized={desk.customized} role={role} contents={contents} />
    </div>
  );
}
