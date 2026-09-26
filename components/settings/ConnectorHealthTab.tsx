// Marketr — connector health tab (Phase B, track B3).
// Client component rendered inside Settings → Connectors. Every connection
// shows a status badge, last successful sync, provider quota where reported,
// the last error with a plain-language fix hint, and a Reconnect button that
// deep-links the existing OAuth/API-key connect flow (no new auth code).

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Notice,
  btnCls,
  cardCls,
  primaryBtnVioletCls,
  type NoticeState,
} from "./ui";

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

const STATUS_BADGE: Record<HealthItem["status"], string> = {
  healthy: "bg-emerald-50 text-emerald-700 border-emerald-200",
  degraded: "bg-amber-50 text-amber-700 border-amber-200",
  needs_reauth: "bg-amber-50 text-amber-700 border-amber-200",
  error: "bg-red-50 text-red-700 border-red-200",
  unknown: "bg-zinc-100 text-zinc-500 border-zinc-200",
};

const STATUS_LABEL: Record<HealthItem["status"], string> = {
  healthy: "Healthy",
  degraded: "Degraded",
  needs_reauth: "Needs re-auth",
  error: "Error",
  unknown: "Unknown",
};

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
          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-emerald-700">
            {summary.healthy} healthy
          </span>
          {summary.needsAttention > 0 && (
            <span className="rounded-full border border-red-200 bg-red-50 px-3 py-1 text-red-700">
              {summary.needsAttention} need{summary.needsAttention === 1 ? "s" : ""} attention
            </span>
          )}
          {summary.unknown > 0 && (
            <span className="rounded-full border border-zinc-200 bg-zinc-100 px-3 py-1 text-zinc-600">
              {summary.unknown} unknown
            </span>
          )}
          <button onClick={load} disabled={loading} className={btnCls}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        </div>
      )}

      {loading && items.length === 0 ? (
        <p className="text-sm text-zinc-500">Loading connector health…</p>
      ) : items.length === 0 ? (
        <div className={cardCls}>
          <p className="text-sm text-zinc-500">
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
                    <h3 className="font-medium">{h.displayName}</h3>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs ${STATUS_BADGE[h.status]}`}
                    >
                      {STATUS_LABEL[h.status]}
                    </span>
                  </div>
                  {h.connectionLabel && (
                    <p className="mt-0.5 truncate text-sm text-zinc-500">{h.connectionLabel}</p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={() => checkNow(h.connectionId)}
                    disabled={checking === h.connectionId}
                    className={btnCls}
                  >
                    {checking === h.connectionId ? "Checking…" : "Check now"}
                  </button>
                  {(h.status === "needs_reauth" || h.status === "error") && (
                    <button
                      onClick={() => onReconnect(h.connectorKey, h.authType)}
                      className={primaryBtnVioletCls}
                    >
                      Reconnect
                    </button>
                  )}
                </div>
              </div>

              <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-xs text-zinc-400">Last successful sync</dt>
                  <dd className="mt-0.5 text-zinc-700">{fmtDate(h.lastSuccessAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-400">Last checked</dt>
                  <dd className="mt-0.5 text-zinc-700">{fmtDate(h.lastCheckAt)}</dd>
                </div>
                <div>
                  <dt className="text-xs text-zinc-400">Provider quota</dt>
                  <dd className="mt-0.5 text-zinc-700">
                    {h.quota && h.quota.limit != null ? (
                      <>
                        {h.quota.used ?? 0} / {h.quota.limit}
                        <span className="ml-2 inline-block h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 align-middle">
                          <span
                            className="block h-full rounded-full bg-[#0E7C66]"
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
                <div className="mt-3 rounded-md border border-zinc-200 bg-[#FAFAF7] px-3 py-2">
                  {h.errorCode && (
                    <p className="text-xs font-medium text-zinc-600">
                      {h.status === "needs_reauth"
                        ? "Needs re-authentication"
                        : h.status === "error"
                          ? "Error"
                          : "Note"}
                    </p>
                  )}
                  {h.fixHint && <p className="mt-0.5 text-sm text-zinc-700">{h.fixHint}</p>}
                  {h.label && <p className="mt-0.5 text-xs text-zinc-500">{h.label}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
