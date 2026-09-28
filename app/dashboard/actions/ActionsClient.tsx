"use client";

// Marketr — Phase 14: Actions client (Connections | Approvals | Activity).
// House pattern: sub-tabs with Lucide icon + brand-active state, dense
// tables with badge columns, brand-var buttons (never hardcoded primary).

import { Fragment, useMemo, useState } from "react";
import {
  Plug,
  ShieldCheck,
  History,
  Check,
  X,
  Pencil,
  Play,
  Loader2,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
import { describeBulk, extractBulkItems } from "@/lib/integrations/actions/bulk";

interface AppDef {
  appKey: string;
  label: string;
  description: string;
}
interface Connection {
  id: string;
  appKey: string;
  status: string;
  scopes: unknown;
  connectedAt: string;
}
interface Approval {
  id: string;
  appKey: string;
  toolName: string;
  riskTier: string;
  plainSummary: string;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  expiresAt: string;
  createdAt: string;
}
interface ActionLog {
  id: string;
  appKey: string;
  toolName: string;
  riskTier: string;
  status: string;
  executedBy: string;
  latencyMs: number | null;
  createdAt: string;
}

type Tab = "connections" | "approvals" | "activity";

const TABS: Array<{ id: Tab; label: string; icon: typeof Plug }> = [
  { id: "connections", label: "Connections", icon: Plug },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "activity", label: "Activity", icon: History },
];

function tierBadge(tier: string) {
  const cls =
    tier === "high"
      ? "bg-red-50 text-red-700 border-red-200"
      : tier === "medium"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : "bg-stone-100 text-stone-600 border-stone-200";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {tier}
    </span>
  );
}

function statusBadge(status: string) {
  const cls =
    status === "connected" || status === "approved" || status === "success"
      ? "bg-emerald-50 text-emerald-700 border-emerald-200"
      : status === "pending"
        ? "bg-amber-50 text-amber-700 border-amber-200"
        : status === "denied" || status === "failed"
          ? "bg-red-50 text-red-700 border-red-200"
          : status === "executed"
            ? "bg-blue-50 text-blue-700 border-blue-200"
            : "bg-stone-100 text-stone-500 border-stone-200";
  return (
    <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}`}>
      {status}
    </span>
  );
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `Request failed (${res.status})`);
  return data as Record<string, unknown>;
}

export function ActionsClient({
  apps,
  initialConnections,
  initialApprovals,
  initialLogs,
}: {
  apps: AppDef[];
  initialConnections: Connection[];
  initialApprovals: Approval[];
  initialLogs: ActionLog[];
}) {
  const [tab, setTab] = useState<Tab>("approvals");
  const [connections, setConnections] = useState(initialConnections);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [logs, setLogs] = useState(initialLogs);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [denyFor, setDenyFor] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("pending");
  // Slice 5: destructive second-confirmation. confirmExec holds the approval
  // id the user has clicked "Execute" on for a HIGH-tier action — the inline
  // confirm panel collects the explicit confirmation before the POST.
  const [confirmExec, setConfirmExec] = useState<string | null>(null);

  const connByApp = useMemo(() => {
    const m = new Map<string, Connection>();
    for (const c of connections) m.set(c.appKey, c);
    return m;
  }, [connections]);

  const visibleApprovals = useMemo(
    () => (filter === "all" ? approvals : approvals.filter((a) => a.status === filter)),
    [approvals, filter],
  );

  async function refresh() {
    const [c, a, l] = await Promise.all([
      api("/api/integrations/actions/connections"),
      api("/api/integrations/actions/approvals?status=all"),
      api("/api/integrations/actions/activity"),
    ]);
    setConnections(c.connections as Connection[]);
    setApprovals(a.approvals as Approval[]);
    setLogs(l.logs as ActionLog[]);
    setSelected(new Set());
  }

  async function run(key: string, fn: () => Promise<void>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function connect(appKey: string) {
    await run(`connect-${appKey}`, async () => {
      const data = await api("/api/integrations/actions/connections", {
        method: "POST",
        body: JSON.stringify({ appKey }),
      });
      // Fresh OAuth link (~12 min TTL) — leave Marketr for Composio now.
      window.location.href = data.connectUrl as string;
    });
  }

  async function openDetail(id: string) {
    if (expanded === id) {
      setExpanded(null);
      setDetail(null);
      return;
    }
    setBusy(`detail-${id}`);
    try {
      const data = await api(`/api/integrations/actions/approvals/${id}`);
      setDetail((data.approval as Record<string, unknown>) ?? null);
      setExpanded(id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function decide(id: string, decision: "approved" | "denied", reason?: string, editedArgs?: Record<string, unknown>) {
    await run(`decide-${id}`, async () => {
      await api(`/api/integrations/actions/approvals/${id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision, reason, editedArgs }),
      });
      setDenyFor(null);
      setDenyReason("");
      setEditing(null);
    });
  }

  /** Execute an approved action. High tier always passes destructiveConfirm
   *  + the reviewed bulk count; the gate enforces both server-side. */
  async function executeApproval(
    a: Approval,
    confirm?: { destructiveConfirm: boolean; confirmedBulkCount?: number },
  ) {
    await run(`exec-${a.id}`, async () => {
      await api(`/api/integrations/actions/approvals/${a.id}/execute`, {
        method: "POST",
        body: JSON.stringify(confirm ?? {}),
      });
      setConfirmExec(null);
    });
  }

  /** Bulk info for the destructive-confirm panel (from the loaded detail). */
  function bulkFor(a: Approval) {
    if (expanded !== a.id || !detail) return null;
    const args =
      (detail as { proposedArgs?: Record<string, unknown> }).proposedArgs ?? {};
    return extractBulkItems(args);
  }

  async function batchApprove() {
    const ids = [...selected];
    if (!ids.length) return;
    await run("batch", async () => {
      for (const id of ids) {
        await api(`/api/integrations/actions/approvals/${id}/decide`, {
          method: "POST",
          body: JSON.stringify({ decision: "approved" }),
        });
      }
    });
  }

  const pendingCount = approvals.filter((a) => a.status === "pending").length;

  return (
    <div className="flex flex-col gap-4">
      {/* Sub-tabs */}
      <div className="flex gap-1 border-b border-stone-200">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${
                active
                  ? "border-[var(--brand-600)] text-[var(--brand-700)]"
                  : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
              {t.id === "approvals" && pendingCount > 0 && (
                <span className="rounded-full bg-[var(--brand-600)] px-1.5 text-[11px] font-semibold text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      {/* ── Connections ─────────────────────────────────────────── */}
      {tab === "connections" && (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">App</th>
                <th className="px-3 py-2 font-medium">What agents can do</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => {
                const conn = connByApp.get(app.appKey);
                const connected = conn?.status === "connected";
                return (
                  <tr key={app.appKey} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                    <td className="px-3 py-2.5 font-medium text-stone-900">{app.label}</td>
                    <td className="px-3 py-2.5 text-stone-500">{app.description}</td>
                    <td className="px-3 py-2.5">{statusBadge(conn?.status ?? "not connected")}</td>
                    <td className="px-3 py-2.5 text-right">
                      {connected ? (
                        <button
                          disabled={busy === `revoke-${conn.id}`}
                          onClick={() =>
                            run(`revoke-${conn!.id}`, async () => {
                              await api(`/api/integrations/actions/connections/${conn!.id}`, { method: "DELETE" });
                            })
                          }
                          className="rounded-md border border-stone-200 px-2.5 py-1 text-[12px] text-stone-600 hover:bg-stone-50 disabled:opacity-50"
                        >
                          {busy === `revoke-${conn.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Revoke"}
                        </button>
                      ) : (
                        <button
                          disabled={busy === `connect-${app.appKey}`}
                          onClick={() => connect(app.appKey)}
                          className="inline-flex items-center gap-1 rounded-md bg-[var(--brand-600)] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
                        >
                          {busy === `connect-${app.appKey}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ExternalLink className="h-3.5 w-3.5" />
                          )}
                          Connect
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="border-t border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
            OAuth runs on Composio&apos;s hosted flow — Marketr stores only the connection
            reference, never your app tokens.
          </div>
        </div>
      )}

      {/* ── Approvals ───────────────────────────────────────────── */}
      {tab === "approvals" && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="rounded-md border border-stone-200 bg-white px-2 py-1.5 text-[13px]"
            >
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="denied">Denied</option>
              <option value="expired">Expired</option>
              <option value="executed">Executed</option>
              <option value="all">All</option>
            </select>
            {selected.size > 0 && (
              <button
                disabled={busy === "batch"}
                onClick={batchApprove}
                className="inline-flex items-center gap-1 rounded-md bg-[var(--brand-600)] px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
              >
                {busy === "batch" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Approve {selected.size} selected
              </button>
            )}
            <span className="text-[12px] text-stone-500">
              Approvals expire automatically — stale proposals can never execute.
            </span>
          </div>

          <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="w-8 px-3 py-2" />
                  <th className="px-3 py-2 font-medium">What will happen</th>
                  <th className="px-3 py-2 font-medium">Tool</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                  <th className="px-3 py-2 font-medium text-right">Review</th>
                </tr>
              </thead>
              <tbody>
                {visibleApprovals.map((a) => (
                  <Fragment key={a.id}>
                    <tr className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                      <td className="px-3 py-2.5">
                        {a.status === "pending" && (
                          <input
                            type="checkbox"
                            checked={selected.has(a.id)}
                            onChange={(e) => {
                              const next = new Set(selected);
                              if (e.target.checked) next.add(a.id);
                              else next.delete(a.id);
                              setSelected(next);
                            }}
                            className="h-3.5 w-3.5 accent-[var(--brand-600)]"
                          />
                        )}
                      </td>
                      <td className="max-w-md px-3 py-2.5 text-stone-800">{a.plainSummary}</td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-stone-500">{a.toolName}</td>
                      <td className="px-3 py-2.5">{tierBadge(a.riskTier)}</td>
                      <td className="px-3 py-2.5">{statusBadge(a.status)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          <button
                            onClick={() => openDetail(a.id)}
                            className="rounded-md border border-stone-200 px-2 py-1 text-[12px] text-stone-600 hover:bg-stone-50"
                          >
                            {expanded === a.id ? "Hide" : "Details"}
                          </button>
                          {a.status === "pending" && (
                            <>
                              <button
                                disabled={busy === `decide-${a.id}`}
                                onClick={() => decide(a.id, "approved")}
                                aria-label={`Approve ${a.toolName}`}
                                className="inline-flex items-center gap-1 rounded-md bg-[var(--brand-600)] px-2 py-1 text-[12px] font-medium text-white hover:bg-[var(--brand-700)] disabled:opacity-50"
                              >
                                <Check className="h-3.5 w-3.5" /> Approve
                              </button>
                              <button
                                disabled={busy === `decide-${a.id}`}
                                onClick={() => setDenyFor(a.id)}
                                aria-label={`Deny ${a.toolName}`}
                                className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-[12px] text-red-700 hover:bg-red-50 disabled:opacity-50"
                              >
                                <X className="h-3.5 w-3.5" /> Deny
                              </button>
                            </>
                          )}
                          {a.status === "approved" && a.riskTier !== "high" && (
                            <button
                              disabled={busy === `exec-${a.id}`}
                              onClick={() => executeApproval(a)}
                              className="inline-flex items-center gap-1 rounded-md border border-stone-200 px-2 py-1 text-[12px] text-stone-700 hover:bg-stone-50 disabled:opacity-50"
                            >
                              {busy === `exec-${a.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                              Execute
                            </button>
                          )}
                          {a.status === "approved" && a.riskTier === "high" && confirmExec !== a.id && (
                            <button
                              disabled={busy === `exec-${a.id}`}
                              onClick={async () => {
                                setConfirmExec(a.id);
                                if (expanded !== a.id) await openDetail(a.id);
                              }}
                              className="inline-flex items-center gap-1 rounded-md border border-red-200 px-2 py-1 text-[12px] font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Execute
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {confirmExec === a.id && a.status === "approved" && a.riskTier === "high" && (
                      <tr key={`${a.id}-confirm`} className="border-b border-red-100 bg-red-50/60">
                        <td />
                        <td colSpan={5} className="px-3 py-3">
                          {(() => {
                            const bulk = bulkFor(a);
                            return (
                              <div className="rounded-md border border-red-200 bg-white p-3">
                                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-red-800">
                                  <AlertTriangle className="h-4 w-4" />
                                  Destructive action — explicit confirmation required
                                </div>
                                <div className="mt-1 text-[12px] text-stone-600">{a.plainSummary}</div>
                                {bulk ? (
                                  <div className="mt-1 text-[12px] font-medium text-red-700">
                                    Bulk review: {describeBulk(bulk)}
                                  </div>
                                ) : (
                                  <div className="mt-1 text-[12px] text-stone-500">
                                    {expanded === a.id ? "Single target." : "Loading target details…"}
                                  </div>
                                )}
                                <div className="mt-2.5 flex gap-1.5">
                                  <button
                                    disabled={busy === `exec-${a.id}`}
                                    onClick={() =>
                                      executeApproval(a, {
                                        destructiveConfirm: true,
                                        ...(bulk ? { confirmedBulkCount: bulk.count } : {}),
                                      })
                                    }
                                    className="inline-flex items-center gap-1 rounded-md bg-red-600 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-red-700 disabled:opacity-50"
                                  >
                                    {busy === `exec-${a.id}` ? (
                                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                      <AlertTriangle className="h-3.5 w-3.5" />
                                    )}
                                    Confirm — execute now
                                  </button>
                                  <button
                                    onClick={() => setConfirmExec(null)}
                                    className="rounded-md border border-stone-200 px-2.5 py-1 text-[12px] text-stone-600 hover:bg-stone-50"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            );
                          })()}
                        </td>
                      </tr>
                    )}
                    {expanded === a.id && detail && (
                      <tr key={`${a.id}-detail`} className="border-b border-stone-100 bg-stone-50/60">
                        <td />
                        <td colSpan={5} className="px-3 py-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                                Proposed arguments (redacted)
                              </div>
                              <pre className="max-h-48 overflow-auto rounded-md border border-stone-200 bg-white p-2 font-mono text-[11px] text-stone-700">
                                {JSON.stringify((detail as { proposedArgs?: unknown }).proposedArgs ?? {}, null, 2)}
                              </pre>
                              {editing === a.id ? (
                                <div className="mt-2">
                                  <textarea
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={6}
                                    className="w-full rounded-md border border-stone-200 p-2 font-mono text-[11px]"
                                  />
                                  <div className="mt-1 flex gap-1.5">
                                    <button
                                      onClick={() => {
                                        try {
                                          const parsed = JSON.parse(editText) as Record<string, unknown>;
                                          decide(a.id, "approved", "args edited before approve", parsed);
                                        } catch {
                                          setError("Edited args are not valid JSON.");
                                        }
                                      }}
                                      className="rounded-md bg-[var(--brand-600)] px-2 py-1 text-[12px] font-medium text-white hover:bg-[var(--brand-700)]"
                                    >
                                      Approve with edits
                                    </button>
                                    <button
                                      onClick={() => setEditing(null)}
                                      className="rounded-md border border-stone-200 px-2 py-1 text-[12px] text-stone-600"
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </div>
                              ) : (
                                a.status === "pending" && (
                                  <button
                                    onClick={() => {
                                      setEditText(
                                        JSON.stringify((detail as { proposedArgs?: unknown }).proposedArgs ?? {}, null, 2),
                                      );
                                      setEditing(a.id);
                                    }}
                                    className="mt-2 inline-flex items-center gap-1 rounded-md border border-stone-200 px-2 py-1 text-[12px] text-stone-600 hover:bg-white"
                                  >
                                    <Pencil className="h-3.5 w-3.5" /> Edit args before approving
                                  </button>
                                )
                              )}
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-stone-500">
                                Audit trail
                              </div>
                              <ul className="space-y-1 text-[12px] text-stone-600">
                                {((detail as { auditTrail?: Array<{ at: string; actor: string; event: string; detail?: string }> }).auditTrail ?? []).map(
                                  (ev, i) => (
                                    <li key={i} className="rounded border border-stone-200 bg-white px-2 py-1">
                                      <span className="font-medium text-stone-800">{ev.event}</span>
                                      <span className="text-stone-400"> · {ev.actor}</span>
                                      {ev.detail && <div className="text-stone-500">{ev.detail}</div>}
                                    </li>
                                  ),
                                )}
                              </ul>
                              {a.decisionReason && (
                                <div className="mt-2 text-[12px] text-stone-600">
                                  <span className="font-medium">Decision reason:</span> {a.decisionReason}
                                </div>
                              )}
                            </div>
                          </div>
                          {denyFor === a.id && (
                            <div className="mt-3 rounded-md border border-red-200 bg-red-50/50 p-2">
                              <div className="mb-1 text-[12px] font-medium text-red-800">
                                Deny with reason (the action is killed):
                              </div>
                              <div className="flex gap-1.5">
                                <input
                                  value={denyReason}
                                  onChange={(e) => setDenyReason(e.target.value)}
                                  placeholder="Why is this denied?"
                                  className="flex-1 rounded-md border border-stone-200 px-2 py-1 text-[12px]"
                                />
                                <button
                                  onClick={() => decide(a.id, "denied", denyReason || "Denied without reason")}
                                  className="rounded-md bg-red-600 px-2 py-1 text-[12px] font-medium text-white hover:bg-red-700"
                                >
                                  Confirm deny
                                </button>
                                <button
                                  onClick={() => setDenyFor(null)}
                                  className="rounded-md border border-stone-200 px-2 py-1 text-[12px] text-stone-600"
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
                {visibleApprovals.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-stone-400">
                      No approvals here yet — proposed agent actions will appear for review.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Activity ────────────────────────────────────────────── */}
      {tab === "activity" && (
        <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-stone-200 bg-stone-50 text-left text-[11px] uppercase tracking-wide text-stone-500">
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">App</th>
                <th className="px-3 py-2 font-medium">Tier</th>
                <th className="px-3 py-2 font-medium">Outcome</th>
                <th className="px-3 py-2 font-medium">By</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id} className="border-b border-stone-100 hover:bg-[var(--brand-50)]/40">
                  <td className="whitespace-nowrap px-3 py-2.5 text-stone-500">
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-stone-700">{l.toolName}</td>
                  <td className="px-3 py-2.5 text-stone-600">{l.appKey}</td>
                  <td className="px-3 py-2.5">{tierBadge(l.riskTier)}</td>
                  <td className="px-3 py-2.5">{statusBadge(l.status)}</td>
                  <td className="max-w-[180px] truncate px-3 py-2.5 text-stone-500">{l.executedBy}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-stone-400">
                    No actions executed yet — every execution is logged here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="border-t border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
            Reads and draft-creators execute automatically and appear here; writes and
            destructive actions only after your approval.
          </div>
        </div>
      )}
    </div>
  );
}
