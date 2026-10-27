// ShapesOS — Home is the Feed (approved flat-feed redesign, WS=desk).
//
// Top to bottom: the greeting, status banners when something needs the
// member, then one flat column — hairline-divided rows, not boxed widgets:
// "Needs you" (pending approvals, each with the queue's own decision path:
// inline Approve / Deny when the queue's API takes a plain POST and the
// viewer's role may decide, Review on the queue's screen otherwise),
// "Running now" (the lead agent and its sub-agents, live), "Earlier" (what
// finished or stopped, newest first), and the agent-written Today briefing.
// The widget desktop lives on at /dashboard/desktop; layouts are per member
// per workspace and route-independent (lib/desktop/store.server.ts), so no
// arrangement is lost. Every loader is best-effort: a source that fails
// leaves its section out, never a broken Home.

import Link from "next/link";
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
import type { InboxResult, InboxSourceKey } from "@/lib/approvals/types";
import { Banner, StatusShape } from "@/components/aos";
import { NewTaskButton } from "@/components/command-bar/NewTaskButton";
import { getUserPreferences } from "@/lib/desktop/prefs";
import { loadWidgets, timeAgo, type BriefingData } from "@/lib/desktop/loaders.server";
import { DEFAULT_TIME_ZONE } from "@/lib/time/zoned";
import { prisma } from "@/lib/prisma";
import { getI18n } from "@/lib/i18n/server";
import type { AgentNode, AgentTree } from "@/lib/aos/agents";
import type { AosStatus } from "@/lib/aos/status";
import { FeedNeedsYou } from "@/components/home/FeedNeedsYou";

export const dynamic = "force-dynamic";

/** Pending requests for this member, best effort (null when unreadable). */
async function feedInbox(userId: string, workspaceId: string): Promise<InboxResult | null> {
  try {
    const viewer = await resolveInboxViewer(userId, workspaceId);
    if (!viewer) return null;
    return await loadInbox(viewer, { limitPerSource: 8 });
  } catch {
    return null;
  }
}

/** The lead agent, its sub-agents and their delegated runs, flattened. */
function flattenTree(tree: AgentTree | null): AgentNode[] {
  if (!tree) return [];
  const out: AgentNode[] = [];
  const walk = (n: AgentNode) => {
    out.push(n);
    for (const c of n.children ?? []) walk(c);
  };
  walk(tree.lead);
  for (const b of tree.branches) walk(b);
  return out;
}

/** One flat feed row: status shape, title + one line of context, time. */
function FeedRow({
  status,
  title,
  line,
  href,
  when,
  source,
  progress,
  timeLabel,
}: {
  status: AosStatus;
  title: string;
  line: string | null;
  href: string | null;
  when: string;
  source: string;
  progress: { done: number; total: number } | null;
  timeLabel: string;
}) {
  const pct = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <li className="flex gap-3 border-t border-line py-4 first:border-t-0 first:pt-1">
      <StatusShape status={status} size={12} className="mt-1" />
      <div className="min-w-0 flex-1">
        <div className="text-[15px] font-medium text-ink">
          {href ? (
            <Link href={href} className="transition-colors hover:text-focus">
              {title}
            </Link>
          ) : (
            title
          )}
        </div>
        {line ? <p className="mt-0.5 text-sm text-muted">{line}</p> : null}
        {pct !== null ? (
          <div className="mt-2 h-1 w-40 overflow-hidden rounded-full bg-line" aria-hidden>
            <div className="h-full rounded-full bg-brand" style={{ width: `${pct}%` }} />
          </div>
        ) : null}
        <div className="mt-1.5 text-xs text-muted">{source}</div>
      </div>
      <span className="shrink-0 text-xs text-muted" title={when}>
        {timeLabel}
      </span>
    </li>
  );
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
  const { t, locale, format } = await getI18n();
  const sourceLabel = (source: InboxSourceKey, fallback: string) => {
    const label = t(`approvals.sources.${source}`);
    return label === `approvals.sources.${source}` ? fallback : label;
  };

  const [prefs, activity, inbox, lastRun] = await Promise.all([
    getUserPreferences(user.id).catch(() => ({ timeZone: null })),
    safeAgentActivity(workspace.id),
    feedInbox(user.id, workspace.id),
    prisma.workflowRun.findFirst({
      where: { workflow: { project: { workspaceId: workspace.id } } },
      orderBy: { startedAt: "desc" },
      select: { startedAt: true, workflow: { select: { name: true } } },
    }).catch(() => null),
  ]);
  const timeZone = prefs.timeZone ?? DEFAULT_TIME_ZONE;
  const briefingResult = await loadWidgets(
    { workspaceId: workspace.id, userId: user.id, role, now, timeZone, workspaceName: workspace.name, t, locale },
    ["briefing"],
  );
  const briefingLoad = briefingResult.briefing;
  const briefing: BriefingData | null = briefingLoad && briefingLoad.ok ? briefingLoad.data : null;

  // ── banners: only when something needs the member ──────────
  const tree = activity?.tree ?? null;
  const failedSchedules: FailedWork[] = (activity?.schedules ?? [])
    .filter((s) => s.status === "failed")
    .map((s) => ({ key: `schedule:${s.id}`, name: s.name, detail: s.error ?? t("home.banners.scheduleFailed"), href: s.href }));
  const approvalsSummary = {
    actionable: inbox?.actionable ?? 0,
    sources: (inbox?.sources ?? []).filter((s) => s.actionable > 0).map((s) => sourceLabel(s.source, s.label)),
  };
  const banners = deriveBanners({ approvals: approvalsSummary, failed: [...failedWorkFromTree(tree), ...failedSchedules] }, t);
  const provider = providerStatus();

  // ── feed sections ──────────────────────────────────────────
  const nodes = flattenTree(tree);
  const running = nodes.filter((n) => n.status === "running");
  const earlier = nodes
    .filter((n) => n.status === "done" || n.status === "failed")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 6);

  // Greeting in the member's timezone (home.greeting.* in lib/i18n).
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: false, timeZone }).format(now),
  );
  const daypart = hour < 12 ? "morning" : hour < 18 ? "afternoon" : "evening";
  const firstName = (user.name ?? "").trim().split(/\s+/)[0] || workspace.name;

  return (
    <div className="mx-auto flex w-full max-w-[660px] flex-col gap-6">
      {/* Greeting */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm text-muted">{format.date(now, "date")}</p>
          <h1 className="aos-heading">{t(`home.greeting.${daypart}`, { name: firstName })}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted">
            <span>{t("home.plan")}</span>
            <ValuePill>{workspace.plan}</ValuePill>
            <span aria-hidden className="text-muted">·</span>
            <span>{t("home.data")}</span>
            <ValuePill>{provider.isLive ? t("home.dataLive") : t("home.dataMock")}</ValuePill>
            {lastRun ? (
              <>
                <span aria-hidden className="text-muted">·</span>
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

      {/* Needs you: pending requests as flat rows with inline decisions. */}
      {inbox && inbox.items.length ? (
        <section aria-label={t("home.feed.needsYou")}>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            {t("home.feed.needsYou")}
          </h2>
          <FeedNeedsYou items={inbox.items} />
        </section>
      ) : null}

      {/* Running now: the lead agent and its sub-agents, live. */}
      {running.length ? (
        <section aria-label={t("home.feed.runningNow")}>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            {t("home.feed.runningNow")}
          </h2>
          <ul>
            {running.map((n) => (
              <FeedRow
                key={n.key}
                status="running"
                title={n.name}
                line={n.line}
                href={n.href}
                when={n.updatedAt}
                source={n.missionName ?? t("home.feed.agent")}
                progress={n.progress}
                timeLabel={timeAgo(new Date(n.updatedAt), now, locale)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* Earlier: what finished or stopped, newest first. */}
      {earlier.length ? (
        <section aria-label={t("home.feed.earlierToday")}>
          <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">
            {t("home.feed.earlierToday")}
          </h2>
          <ul>
            {earlier.map((n) => (
              <FeedRow
                key={n.key}
                status={n.status}
                title={n.name}
                line={n.line}
                href={n.href}
                when={n.updatedAt}
                source={n.missionName ?? t("home.feed.agent")}
                progress={null}
                timeLabel={timeAgo(new Date(n.updatedAt), now, locale)}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {/* Today, from the lead agent. */}
      {briefing && briefing.status === "ready" && briefing.body ? (
        <section aria-label={t("home.feed.briefing")} className="rounded-lg border border-line bg-surface p-4">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
            {t("home.feed.briefing")}
          </h2>
          <p className="text-sm leading-relaxed text-ink">{briefing.body}</p>
          {briefing.writtenAt ? (
            <p className="mt-2 text-xs text-muted">
              {t("home.feed.writtenAgo", { ago: timeAgo(new Date(briefing.writtenAt), now, locale) })}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* The widget desktop is still here, one tap away. */}
      <p className="text-sm">
        <Link href="/dashboard/desktop" className="text-ink underline underline-offset-2 hover:text-focus">
          {t("home.feed.openDesktop")}
        </Link>
      </p>
    </div>
  );
}
