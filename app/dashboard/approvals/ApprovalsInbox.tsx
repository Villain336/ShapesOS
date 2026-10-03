// ShapesOS — unified "needs you" inbox (Phase 3 J).
//
// Dense table over GET /api/approvals/inbox. Each row: queue, what it is,
// who asked, age, risk, and either inline Approve/Deny (when the queue's own
// API takes a plain POST and the viewer's role may decide) or a Review link
// to the queue's own approve/deny screen. Inline decisions call the queue's
// route directly, which re-checks every rule (role, separation of duties,
// two-person approvals, expiry).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowUpRight,
  Check,
  CheckCircle2,
  Loader2,
  Lock,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { refreshNeedsYouCount } from "@/components/approvals/NeedsYouBadge";
import {
  INBOX_SOURCE_LABELS,
  ageLabel,
  type InboxAction,
  type InboxItem,
  type InboxResult,
  type InboxSourceKey,
} from "@/lib/approvals/types";

type SourceFilter = InboxSourceKey | "all";

// Risk is a property of the request, not an agent state — neutral chips only.
function RiskChip({ risk }: { risk: InboxItem["risk"] }) {
  const label = risk === "high" ? "High" : risk === "medium" ? "Medium" : "Low";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ${
        risk === "high" ? "bg-ink text-white" : "bg-paper text-muted shadow-control"
      }`}
    >
      {label}
    </span>
  );
}

function QueueChip({ item }: { item: InboxItem }) {
  return (
    <span className="inline-flex max-w-full items-center whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-ink shadow-control">
      <span className="truncate">{item.typeLabel}</span>
    </span>
  );
}

const btnApprove =
  "inline-flex h-control-sm min-w-[96px] items-center justify-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm min-w-[80px] items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] disabled:opacity-40";
const btnReview =
  "inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-needs px-4 text-sm font-semibold text-ink aos-press";
const btnOpen =
  "inline-flex h-control-sm items-center justify-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper";
const selectCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]";

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

export default function ApprovalsInbox({ initialSource = "all" }: { initialSource?: SourceFilter }) {
  const [data, setData] = useState<InboxResult | null>(null);
  const [source, setSource] = useState<SourceFilter>(initialSource);
  const [onlyMine, setOnlyMine] = useState(false);
  const [query, setQuery] = useState("");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/approvals/inbox", { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Couldn't load approvals.");
      setData(body as InboxResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load approvals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (data?.items ?? []).filter((i) => {
      if (source !== "all" && i.source !== source) return false;
      if (onlyMine && !i.canDecide) return false;
      if (!q) return true;
      return [i.title, i.detail, i.typeLabel, i.requester]
        .filter(Boolean)
        .some((s) => (s as string).toLowerCase().includes(q));
    });
  }, [data, source, onlyMine, query]);

  const sourceOptions = useMemo(
    () => (data?.sources ?? []).filter((s) => s.total > 0 || s.source === source),
    [data, source],
  );

  async function decide(item: InboxItem, which: "approve" | "deny") {
    const action = which === "approve" ? item.approve : item.deny;
    if (!action) return;
    setBusyKey(item.key);
    setError(null);
    setNotice(null);
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
      setNotice(`${which === "approve" ? "Approved" : "Denied"}: ${item.title}`);
      refreshNeedsYouCount();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusyKey(null);
    }
  }

  if (data === null && !error) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={16} className="aos-spin" />
        Loading approvals…
      </div>
    );
  }

  const actionable = data?.actionable ?? 0;

  return (
    <div className="flex flex-col gap-3">
      {actionable > 0 && (
        <div role="status" className="flex items-center gap-2.5 rounded-lg bg-needs px-4 py-3 text-ink">
          <span
            className="aos-shape aos-shape--needs [--aos-shape-size:14px]"
            style={{ color: "inherit" }}
            aria-hidden
          />
          <p className="text-sm font-semibold">
            {actionable} approval{actionable === 1 ? "" : "s"} need{actionable === 1 ? "s" : ""} you.
          </p>
        </div>
      )}

      {/* Filter toolbar: queue dropdown + scope chip + search + refresh. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor="approvals-source">
          Queue
        </label>
        <select
          id="approvals-source"
          value={source}
          onChange={(e) => setSource(e.target.value as SourceFilter)}
          className={selectCls}
        >
          <option value="all">All queues ({data?.total ?? 0})</option>
          {sourceOptions.map((s) => (
            <option key={s.source} value={s.source}>
              {s.label} ({s.total})
            </option>
          ))}
        </select>
        <button
          type="button"
          aria-pressed={onlyMine}
          onClick={() => setOnlyMine((v) => !v)}
          className={`inline-flex h-chip items-center gap-1.5 rounded-full px-3 text-sm font-semibold aos-press ${
            onlyMine ? "bg-ink text-white" : "bg-paper text-ink shadow-control hover:shadow-outline"
          }`}
        >
          Only what I can decide
        </button>
        <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-subtle" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search approvals"
            aria-label="Search approvals"
            className="h-control-sm w-full rounded-md border-[1.5px] border-control bg-paper pl-8 pr-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)]"
          />
        </div>
        <button
          type="button"
          onClick={() => void load()}
          disabled={loading}
          className="ml-auto inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press disabled:opacity-60"
        >
          <RefreshCw size={14} className={loading ? "aos-spin" : undefined} />
          {loading ? "Refreshing" : "Refresh"}
        </button>
      </div>

      {notice && (
        <div role="status" className="flex items-center gap-2 rounded-lg bg-paper px-3 py-2 text-sm text-ink shadow-hairline">
          <span className="aos-shape aos-shape--done" aria-hidden />
          {notice}
          <button onClick={() => setNotice(null)} className="ml-auto text-muted hover:text-ink" aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
        >
          <span className="aos-shape aos-shape--failed [--aos-shape-size:10px]" aria-hidden />
          {error}
          <button onClick={() => setError(null)} className="ml-auto" aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-lg bg-paper px-6 py-12 text-center shadow-hairline">
          <CheckCircle2 size={28} className="text-subtle" />
          <div className="text-sm font-semibold text-ink">
            {data && data.total > 0 ? "Nothing matches these filters" : "All caught up"}
          </div>
          <div className="max-w-[360px] text-sm text-muted">
            {data && data.total > 0
              ? "Clear the search or pick another queue to see the rest."
              : "Nothing is waiting on you. When an agent or a teammate needs a sign-off, it shows up here."}
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-semibold">Type</th>
                <th className="px-3 py-2 font-semibold">Request</th>
                <th className="px-3 py-2 font-semibold">Requested by</th>
                <th className="px-3 py-2 font-semibold">Age</th>
                <th className="px-3 py-2 font-semibold">Risk</th>
                <th className="px-3 py-2 text-right font-semibold">Decision</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const busy = busyKey === item.key;
                return (
                  <tr key={item.key} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="max-w-[200px] px-3 py-2.5 align-top">
                      <QueueChip item={item} />
                      <div className="mt-1 text-xs text-subtle">{INBOX_SOURCE_LABELS[item.source]}</div>
                    </td>
                    <td className="max-w-[340px] px-3 py-2.5 align-top">
                      <div className="truncate font-medium text-ink" title={item.title}>
                        {item.title}
                      </div>
                      {item.detail && (
                        <div className="truncate text-xs text-muted" title={item.detail}>
                          {item.detail}
                        </div>
                      )}
                    </td>
                    <td className="max-w-[160px] px-3 py-2.5 align-top">
                      <div className="truncate text-ink">{item.requester ?? "—"}</div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 align-top text-muted">
                      <span title={new Date(item.createdAt).toLocaleString()}>{ageLabel(item.createdAt)}</span>
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <RiskChip risk={item.risk} />
                    </td>
                    <td className="px-3 py-2.5 align-top">
                      <div className="flex flex-wrap items-center justify-end gap-2">
                        {item.approve && item.deny ? (
                          <>
                            <button
                              onClick={() => void decide(item, "approve")}
                              disabled={busy}
                              aria-label={`Approve ${item.title}`}
                              className={btnApprove}
                            >
                              {busy ? <Loader2 size={15} className="aos-spin" /> : <Check size={15} />}
                              Approve
                            </button>
                            <button
                              onClick={() => void decide(item, "deny")}
                              disabled={busy}
                              aria-label={`Deny ${item.title}`}
                              className={btnDeny}
                            >
                              <X size={15} />
                              Deny
                            </button>
                            <Link href={item.href} className={btnOpen} aria-label={`Open ${item.title}`}>
                              <ArrowUpRight size={15} />
                            </Link>
                          </>
                        ) : item.canDecide ? (
                          <Link href={item.href} className={btnReview}>
                            Review
                            <ArrowUpRight size={15} />
                          </Link>
                        ) : (
                          <>
                            <span className="inline-flex items-center gap-1 text-xs text-muted" title={item.blockedReason ?? undefined}>
                              <Lock size={12} aria-hidden />
                              <span className="max-w-[180px] truncate">{item.blockedReason}</span>
                            </span>
                            <Link href={item.href} className={btnOpen}>
                              Open
                              <ArrowUpRight size={15} />
                            </Link>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data && data.errors.length > 0 && (
        <div className="rounded-lg border border-line bg-paper px-3 py-2 text-xs text-muted">
          Couldn't load: {data.errors.map((e) => INBOX_SOURCE_LABELS[e.source]).join(", ")}. The rest of the
          inbox is up to date — refresh to try again.
        </div>
      )}

      <p className="text-xs text-muted">
        Approve and Deny call each queue's own approval API, which re-checks your role, expiry and
        separation of duties. Items marked Review open the queue's own screen, for decisions that need
        more context (one-time codes, send channels, edits).
      </p>
    </div>
  );
}
