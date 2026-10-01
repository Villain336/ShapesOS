// Marketr — alert event history UI (milestone 13).
// Client component: status filter + per-event channel results + retry for failed.

"use client";

import { useState } from "react";
import { Check, X } from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-medium text-muted shadow-control";
const failChipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-failed-tint px-2 py-0.5 text-xs font-medium text-failed-text";

interface ChannelResult {
  channelId: string;
  name: string;
  type: string;
  ok: boolean;
  error?: string;
}

interface AlertEvent {
  id: string;
  ruleId: string;
  ruleName: string;
  trigger: string;
  triggerLabel: string;
  title: string;
  body: string;
  link: string | null;
  queueReason: string | null;
  status: "queued" | "sent" | "failed" | "suppressed";
  /** Channel results, digest folds, or suppression markers. */
  results: unknown[];
  retryCount: number;
  createdAt: string;
  sentAt: string | null;
}

function isChannelResult(r: unknown): r is ChannelResult {
  return typeof r === "object" && r !== null && "name" in r && "ok" in r;
}

export default function AlertHistory({
  initial,
  rules,
  canRetry,
}: {
  initial: AlertEvent[];
  rules: { id: string; name: string }[];
  canRetry: boolean;
}) {
  const [events, setEvents] = useState<AlertEvent[]>(initial);
  const [status, setStatus] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [loading, setLoading] = useState(false);
  const [retrying, setRetrying] = useState<string | null>(null);

  async function load(nextStatus = status, nextRule = ruleId) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (nextStatus) params.set("status", nextStatus);
      if (nextRule) params.set("ruleId", nextRule);
      const res = await fetch(`/api/alerts?${params.toString()}`);
      const json = await res.json();
      if (res.ok) setEvents(json.events);
    } finally {
      setLoading(false);
    }
  }

  async function retry(e: AlertEvent) {
    setRetrying(e.id);
    try {
      const res = await fetch(`/api/alerts/${e.id}/retry`, { method: "POST" });
      const json = await res.json();
      if (res.ok) {
        setEvents((es) =>
          es.map((x) =>
            x.id === e.id
              ? { ...x, status: json.event.status, results: json.event.results, retryCount: json.event.retryCount, sentAt: json.event.sentAt }
              : x,
          ),
        );
      }
    } finally {
      setRetrying(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <select
          className={inputCls}
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            load(e.target.value, ruleId);
          }}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
          <option value="queued">Queued</option>
          <option value="suppressed">Suppressed</option>
        </select>
        <select
          className={inputCls}
          value={ruleId}
          onChange={(e) => {
            setRuleId(e.target.value);
            load(status, e.target.value);
          }}
          aria-label="Filter by rule"
        >
          <option value="">All rules</option>
          {rules.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
        {loading && <span className="self-center text-sm text-muted">Loading…</span>}
      </div>

      {events.map((e) => (
        <div key={e.id} className="rounded-lg border border-line bg-paper p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={chipCls}>{e.status}</span>
                <span className="text-xs text-muted">{e.triggerLabel}</span>
                <span className="text-xs text-muted">· {e.ruleName}</span>
                {e.queueReason && (
                  <span className="text-xs text-muted">· waiting: {e.queueReason}</span>
                )}
              </div>
              <p className="mt-2 font-medium text-ink">{e.title}</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{e.body}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {e.results.map((r, i) =>
                  isChannelResult(r) ? (
                    <span
                      key={i}
                      title={r.error ?? undefined}
                      className={r.ok ? chipCls : failChipCls}
                    >
                      {r.ok ? (
                        <Check size={12} aria-hidden="true" />
                      ) : (
                        <X size={12} aria-hidden="true" />
                      )}
                      {r.name}
                      {r.error ? `: ${r.error}` : ""}
                    </span>
                  ) : (
                    <span key={i} className={chipCls}>
                      {typeof r === "object" && r !== null && "digest" in r ? "folded into digest" : "suppressed"}
                    </span>
                  ),
                )}
              </div>
              <p className="mt-2 text-xs text-muted">
                {new Date(e.createdAt).toLocaleString()}
                {e.retryCount > 0 && ` · ${e.retryCount} ${e.retryCount === 1 ? "attempt" : "attempts"}`}
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-2">
              {e.link && (
                <a href={e.link} className={btnGhost}>
                  Open
                </a>
              )}
              {canRetry && (e.status === "failed" || e.status === "queued") && (
                <button className={btnGhost} onClick={() => retry(e)} disabled={retrying === e.id}>
                  {retrying === e.id ? "Retrying…" : "Retry"}
                </button>
              )}
            </div>
          </div>
        </div>
      ))}
      {!events.length && <p className="text-sm text-muted">No alert events yet.</p>}
    </div>
  );
}
