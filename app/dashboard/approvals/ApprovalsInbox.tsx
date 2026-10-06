// ShapesOS — unified "needs you" inbox (Phase 3 J; Agentic OS 4d).
//
// Every pending request from GET /api/approvals/inbox as a kit approval
// card (agent-blocks.png): yellow "Needs your approval" header with the
// agent that asked, the request, what it covers, then the queue's own
// decision path —
//   inline Deny / Edit / Approve when the queue's API takes a plain POST and
//   the viewer's role may decide (the queue's route re-checks every rule:
//   role, separation of duties, two-person approvals, expiry);
//   Review on the queue's own screen otherwise (codes, channels, edits);
//   the reason + Open when the viewer's role can't decide.
// Mission requests hang under the lead agent → the sub-agent waiting on
// them; a needs-you banner sums it up; results come back as toasts.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Inbox, Loader2, RefreshCw, Search } from "lucide-react";
import { refreshNeedsYouCount } from "@/components/approvals/NeedsYouBadge";
import { AgentTree, ApprovalCard, Banner, FilterPill, aosButton } from "@/components/aos";
import {
  ageLabel,
  type InboxAction,
  type InboxItem,
  type InboxResult,
  type InboxSourceKey,
} from "@/lib/approvals/types";
import {
  approvalAgent,
  approvalBody,
  approvalMode,
  approvalQuestion,
  approvalsBanner,
  approveLabelFor,
  decisionToast,
  editLabelFor,
  groupApprovals,
  type MissionAgentIndex,
} from "@/lib/aos/approvals";
import { toast, toastError } from "@/lib/ui/feedback";
// Phase 18.1 (WS=find): the inbox chrome in the person's language. Item text
// (titles, details, requester) is workspace data and is never translated.
import { useI18n } from "@/components/i18n/I18nProvider";

type SourceFilter = InboxSourceKey | "all";

async function runAction(action: InboxAction): Promise<void> {
  const res = await fetch(action.url, {
    method: action.method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(action.body ?? {}),
  });
  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* keep the status message */
    }
    throw new Error(message);
  }
}

function cardId(item: InboxItem): string {
  return `approval-${item.key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function ageText(iso: string, ago: (age: string) => string): string {
  const a = ageLabel(iso);
  return a === "just now" || a === "—" ? a : ago(a);
}

function CardFor({
  item,
  missionAgents,
  busy,
  onDecide,
}: {
  item: InboxItem;
  missionAgents: MissionAgentIndex;
  busy: "approve" | "deny" | null;
  onDecide: (item: InboxItem, which: "approve" | "deny") => void;
}) {
  const mode = approvalMode(item);
  const { t, format } = useI18n();
  return (
    <ApprovalCard
      id={cardId(item)}
      agent={approvalAgent(item, missionAgents)}
      title={approvalQuestion(item)}
      meta={
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
          <span className="font-semibold text-ink">{item.typeLabel}</span>
          <span aria-hidden>·</span>
          <span title={format.date(item.createdAt, "dateTime")}>{ageText(item.createdAt, (age) => t("approvals.ago", { age }))}</span>
          <span aria-hidden>·</span>
          <span className={item.risk === "high" ? "font-semibold text-ink" : undefined}>{t(`approvals.risk.${item.risk}`)}</span>
        </span>
      }
      body={approvalBody(item, missionAgents)}
      items={item.lines.map((l, i) => ({ key: `${i}:${l.label}`, label: l.label, detail: l.detail ?? undefined }))}
      totalItems={item.lineTotal}
      showAllHref={item.href}
      mode={mode}
      approveLabel={approveLabelFor(item)}
      editLabel={editLabelFor(item)}
      editHref={mode === "decide" ? item.href : undefined}
      reviewHref={item.href}
      blockedReason={item.blockedReason}
      openHref={item.href}
      busy={busy}
      onApprove={() => onDecide(item, "approve")}
      onDeny={() => onDecide(item, "deny")}
    />
  );
}

export default function ApprovalsInbox({
  initialSource = "all",
  missionAgents = {},
}: {
  initialSource?: SourceFilter;
  missionAgents?: MissionAgentIndex;
}) {
  const [data, setData] = useState<InboxResult | null>(null);
  const [source, setSource] = useState<SourceFilter>(initialSource);
  const [onlyMine, setOnlyMine] = useState(false);
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<{ key: string; which: "approve" | "deny" } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { t } = useI18n();

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetch("/api/approvals/inbox", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? t("approvals.loadError"));
      setData(body as InboxResult);
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : t("approvals.loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => {
      if (source !== "all" && i.source !== source) return false;
      if (onlyMine && !i.canDecide) return false;
      if (!q) return true;
      return [i.title, i.detail, i.typeLabel, i.requester, i.missionName]
        .filter(Boolean)
        .some((s) => (s as string).toLowerCase().includes(q));
    });
  }, [data, source, onlyMine, query]);

  const sourceOptions = useMemo(
    () => (data?.sources ?? []).filter((s) => s.total > 0 || s.source === source),
    [data, source],
  );

  const grouped = useMemo(() => groupApprovals(items, missionAgents), [items, missionAgents]);
  const banner = useMemo(() => approvalsBanner(data?.items ?? [], missionAgents), [data, missionAgents]);
  const firstMine = useMemo(() => (data?.items ?? []).find((i) => i.canDecide) ?? null, [data]);

  async function decide(item: InboxItem, which: "approve" | "deny") {
    const action = which === "approve" ? item.approve : item.deny;
    if (!action) return;
    setBusy({ key: item.key, which });
    try {
      await runAction(action);
      setData((prev) =>
        prev
          ? {
              ...prev,
              items: prev.items.filter((i) => i.key !== item.key),
              total: prev.total - 1,
              actionable: prev.actionable - (item.canDecide ? 1 : 0),
            }
          : prev,
      );
      toast({ ...decisionToast(item, which), status: "done" });
      refreshNeedsYouCount();
    } catch (e) {
      toastError(which === "approve" ? t("approvals.couldNotApprove") : t("approvals.couldNotDeny"), e instanceof Error ? e.message : t("approvals.decisionFailed"));
    } finally {
      setBusy(null);
    }
  }

  if (data === null && !loadError) {
    return (
      <div className="flex items-center gap-2 text-md text-muted">
        <Loader2 size={16} className="aos-spin" aria-hidden />
        {t("approvals.loading")}
      </div>
    );
  }

  const card = (item: InboxItem) => (
    <CardFor
      key={item.key}
      item={item}
      missionAgents={missionAgents}
      busy={busy?.key === item.key ? busy.which : null}
      onDecide={(i, w) => void decide(i, w)}
    />
  );

  const filtered = source !== "all" || onlyMine || query.trim().length > 0;

  return (
    <div className="flex flex-col gap-5">
      {banner ? (
        <Banner
          status="needs"
          title={banner.title}
          description={banner.description}
          action={firstMine ? { label: t("approvals.startWithNewest"), href: `#${cardId(firstMine)}` } : null}
        />
      ) : null}

      {/* Filters: queue pills, scope toggle, search, refresh. */}
      <div className="flex flex-col gap-3">
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1" role="group" aria-label={t("approvals.filterByQueue")}>
          <FilterPill selected={source === "all"} count={data?.total ?? 0} onClick={() => setSource("all")}>
            {t("approvals.all")}
          </FilterPill>
          {sourceOptions.map((s) => (
            <FilterPill key={s.source} selected={source === s.source} count={s.total} onClick={() => setSource(s.source)}>
              {t(`approvals.sources.${s.source}`)}
            </FilterPill>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <FilterPill selected={onlyMine} onClick={() => setOnlyMine((v) => !v)}>
            {t("approvals.onlyMine")}
          </FilterPill>
          <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
            <Search size={15} className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-subtle" aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("approvals.searchPlaceholder")}
              aria-label={t("approvals.searchLabel")}
              className="h-control-sm w-full rounded-md border-[1.5px] border-control bg-paper pr-3 pl-9 text-md text-ink placeholder:text-subtle focus:border-focus focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className={aosButton({ variant: "secondary", size: "sm", className: "ml-auto" })}
          >
            <RefreshCw size={14} className={loading ? "aos-spin" : undefined} aria-hidden />
            {loading ? t("common.refreshing") : t("common.refresh")}
          </button>
        </div>
      </div>

      {loadError ? (
        <p role="alert" className="flex items-center gap-2 text-md text-failed-text">
          <span className="size-2.5 shrink-0 bg-failed" aria-hidden />
          {t("approvals.refreshToRetry", { error: loadError })}
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg bg-paper px-6 py-14 text-center shadow-hairline">
          <Inbox size={28} className="text-subtle" aria-hidden />
          <h2 className="aos-subheading">{data && data.total > 0 && filtered ? t("approvals.noMatchTitle") : t("approvals.emptyTitle")}</h2>
          <p className="max-w-[44ch] text-md text-muted">
            {data && data.total > 0 && filtered ? t("approvals.noMatchBody") : t("approvals.emptyBody")}
          </p>
          {data && data.total > 0 && filtered ? (
            <button
              type="button"
              onClick={() => {
                setSource("all");
                setOnlyMine(false);
                setQuery("");
              }}
              className={aosButton({ variant: "secondary", size: "sm" })}
            >
              {t("approvals.clearFilters")}
            </button>
          ) : null}
        </div>
      ) : (
        <>
          {grouped.lead ? (
            <section aria-labelledby="from-missions-h" className="flex flex-col gap-3">
              <h2 id="from-missions-h" className="aos-subheading">
                {t("approvals.fromAgents")}
              </h2>
              <div className="rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
                <AgentTree
                  lead={grouped.lead}
                  branches={grouped.groups.map((g) => g.node)}
                  renderBranchContent={(node) => {
                    const group = grouped.groups.find((g) => g.node.key === node.key);
                    return group ? <div className="grid gap-4 xl:grid-cols-2">{group.items.map(card)}</div> : null;
                  }}
                />
              </div>
            </section>
          ) : null}

          {grouped.other.length > 0 ? (
            <section aria-labelledby="other-requests-h" className="flex flex-col gap-3">
              <h2 id="other-requests-h" className="aos-subheading">
                {grouped.lead ? t("approvals.fromApps") : t("approvals.requests")}
              </h2>
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">{grouped.other.map(card)}</div>
            </section>
          ) : null}
        </>
      )}

      {data && data.errors.length > 0 ? (
        <p className="rounded-md bg-paper px-4 py-3 text-sm text-muted shadow-hairline">
          {t("approvals.sourcesFailed", { sources: data.errors.map((e) => t(`approvals.sources.${e.source}`)).join(", ") })}
        </p>
      ) : null}

      <p className="text-sm text-muted">
        {t("approvals.footnote")}
      </p>
    </div>
  );
}
