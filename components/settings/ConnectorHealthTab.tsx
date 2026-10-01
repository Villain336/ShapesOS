// Marketr — connector health tab (Phase B, track B3).
// Client component rendered inside Settings → Connectors. Every connection
// shows a status badge, last successful sync, provider quota where reported,
// the last error with a plain-language fix hint, and a Reconnect button that
// deep-links the existing OAuth/API-key connect flow (no new auth code).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "lucide-react";

// AOS atoms (local — components/settings/ui.tsx is owned by another slice).
const cardCls = "rounded-xl border border-line bg-paper p-5";
const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const chipCls =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2.5 py-1 text-sm text-muted shadow-control";

type NoticeKind = "ok" | "error" | "info";
interface NoticeState {
  kind: NoticeKind;
  message: string;
}

function Notice({ notice }: { notice: NoticeState | null }) {
  if (!notice) return null;
  if (notice.kind === "error") {
    return (
      <div
        role="alert"
        className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text"
      >
        <span className="mt-1 h-3 w-3 shrink-0 bg-failed" aria-hidden="true" />
        <span>{notice.message}</span>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-line bg-paper px-3 py-2 text-sm text-muted">
      <Check size={14} className="mt-0.5 shrink-0 text-ink" aria-hidden="true" />
      <span>{notice.message}</span>
    </div>
  );
}

export interface HealthItem {
  connectionId: string;
  connectorKey: string;
  displayName: string;
  connectionLabel: string | null;
  authType: "oauth2" | "api_key" | "none";
  connectionStatus: string;
  status: "healthy" | "degraded" | "needs_reauth" | "error" | "unknown";
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  errorCode: string | null;
  fixHint: string | null;
  quota: { used: number | null; limit: number | null } | null;
  liveCheck: boolean;
  label: string | null;
}

interface Summary {
  total: number;
  healthy: number;
  needsAttention: number;
  unknown: number;
  degraded: number;
}

// Connector health is a provider state, not an agent state — neutral chips.
const STATUS_LABEL: Record<HealthItem["status"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  needs_reauth: "Needs re-auth",
  error: "Error",
  unknown: "Unknown",
};

function StatusChip({ status }: { status: HealthItem["status"] }) {
  return <span className={chipCls}>{STATUS_LABEL[status]}</span>;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ConnectorHealthTab({
  workspaceId,
  onReconnect,
}: {
  workspaceId: string;
  onReconnect: (key: string, authType: HealthItem["authType"]) => void;
}) {
  const [items, setItems] = useState<HealthItem[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState<string | null>(null);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/connections/health?${q}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({ kind: "error", message: "Could not load connector health." });
        return;
      }
      setItems(j.connections ?? []);
      setSummary(j.summary ?? null);
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    load();
  }, [load]);

  async function checkNow(id: string) {
    setChecking(id);
    setNotice(null);
    try {
      const r = await fetch(`/api/connections/${encodeURIComponent(id)}/check?${q}`, {
        method: "POST",
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message:
            j && typeof j === "object" && "error" in j && typeof j.error === "string"
              ? j.error
              : "Health check failed.",
        });
        return;
      }
      const h = j.health as HealthItem;
      setItems((prev) => prev.map((i) => (i.connectionId === id ? h : i)));
    } finally {
      setChecking(null);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Notice notice={notice} />

      {summary && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className={chipCls}>{summary.healthy} healthy</span>
          {summary.needsAttention > 0 && (
            <span className={chipCls}>
              {summary.needsAttention} need{summary.needsAttention === 1 ? "s" : ""} attention
            </span>
          )}
          {summary.unknown > 0 && (
            <span className={chipCls}>{summary.unknown} unknown</span>
          )}
          <button onClick={load} disabled={loading} className={btnGhost}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <p className="text-sm text-muted">Loading connector health…</p>
      ) : items.length === 0 ? (
        <div className={cardCls}>
          <p className="text-sm text-muted">
            No connections yet. Connect a data source on the Connections tab to
            start tracking its health.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {items.map((h) => (
            <div
              key={h.connectionId}
              data-testid={`health-row-${h.connectorKey}`}
              className={cardCls}
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="font-medium text-ink">{h.displayName}</h3>
                    <StatusChip status={h.status} />
                  </div>
                  {h.connectionLabel && (
                    <p className="mt-0.5 truncate text-sm text-muted">{h.connectionLabel}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => checkNow(h.connectionId)}
                    disabled={checking === h.connectionId}
                    className={btnGhost}
                  >
                    {checking === h.connectionId ? "Checking…" : "Check now"}
                  </button>
                  {(h.status === "needs_reauth" || h.status === "error") && (
                    <button
                      onClick={() => onReconnect(h.connectorKey, h.authType)}
                      className={btnPrimary}
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              </div>

              <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-subtle">Last successful sync</dt>
                  <dd className="mt-0.5 text-ink">{fmtDate(h.lastSuccessAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle">Last checked</dt>
                  <dd className="mt-0.5 text-ink">{fmtDate(h.lastCheckAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-subtle">Provider quota</dt>
                  <dd className="mt-0.5 text-ink">
                    {h.quota && h.quota.limit != null ? (
                      <>
                        {h.quota.used ?? 0} / {h.quota.limit}
                        <span className="ml-2 inline-block h-1.5 w-24 overflow-hidden rounded-full bg-canvas align-middle">
                          <span
                            className="block h-full rounded-full bg-ink"
                            style={{
                              width: `${Math.min(100, ((h.quota.used ?? 0) / h.quota.limit) * 100)}%`,
                            }}
                          />
                        </span>
                      </>
                    ) : (
                      "Not reported"
                    )}
                  </dd>
                </div>
              </dl>

              {(h.fixHint || h.label) && (
                <div className="mt-3 rounded-md border border-line bg-canvas px-3 py-2">
                  {h.errorCode && (
                    <p className="text-xs font-medium text-ink">
                      {h.status === "needs_reauth"
                        ? "Needs re-authentication"
                        : h.status === "error"
                          ? "Error"
                          : "Note"}
                    </p>
                  )}
                  {h.fixHint && <p className="mt-0.5 text-sm text-muted">{h.fixHint}</p>}
                  {h.label && <p className="mt-0.5 text-xs text-subtle">{h.label}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
