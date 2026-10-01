"use client";

// Marketr — Phase 14: Actions client (Connections | Toolkits | Approvals | Activity).
// Phase 15 slice 3 adds the Toolkits tab: the full firehose directory with
// per-workspace enable/disable (no packs). House pattern: sub-tabs with
// Lucide icon + brand-active state, dense tables with badge columns,
// brand-var buttons (never hardcoded primary).

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Plug,
  ShieldCheck,
  History,
  LayoutGrid,
  Search,
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
  toolkitSlug: string | null;
  status: string;
  executedBy: string;
  latencyMs: number | null;
  createdAt: string;
}
// Phase 15 slice 4: per-workspace budget + per-toolkit attribution (spec §5).
interface WorkspaceBudgetCheck {
  usage: number;
  budget: number | null;
  pct: number;
  alertDue: boolean;
  hardCap: boolean;
  blocked: boolean;
  warning?: string;
}
interface ToolkitAttribution {
  total: number;
  byToolkit: Record<string, number>;
}
interface ToolkitEntry {
  toolkitSlug: string;
  appKey: string;
  label: string;
  description: string;
  category: string;
  connected: boolean;
  enabled: boolean;
  toolCount: number;
  tierBreakdown: { low: number; medium: number; high: number; unclassified: number };
}
// Phase 15 slice 5: catalog drift detection (spec §1, §6).
interface DriftReportRow {
  id: string;
  appKey: string;
  toolkitSlug: string;
  changeType: "added" | "removed" | "renamed";
  toolSlug: string;
  oldSlug: string | null;
  detectedAt: string;
  acknowledgedAt: string | null;
}
interface StaleOverrideRow {
  toolSlug: string;
  reason: string;
}
interface DriftState {
  reports: DriftReportRow[];
  unacknowledgedCount: number;
  staleOverrides: StaleOverrideRow[];
}

type Tab = "connections" | "toolkits" | "approvals" | "activity";

const TABS: Array<{ id: Tab; label: string; icon: typeof Plug }> = [
  { id: "connections", label: "Connections", icon: Plug },
  { id: "toolkits", label: "Toolkits", icon: LayoutGrid },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "activity", label: "Activity", icon: History },
];

const TOOLKIT_CATEGORIES = ["comms", "crm", "files", "payments", "productivity", "support"];

const badgeBase =
  "inline-flex h-badge items-center gap-1.5 rounded-full px-3 text-sm font-semibold";

// Neutral chip for categories and provider states (12a ClipsApp idiom).
const chipNeutral =
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-1.5 py-0.5 text-[10px] font-medium leading-tight text-muted shadow-control";

// Action button idioms (Agentic OS): primary black pill, secondary white
// with shadow-outline, approve = done fill, deny = white + failed-text with
// 1.5px failed inset ring, review = needs fill with black text, execute =
// failed fill.
const BTN_PRIMARY =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const BTN_SECONDARY =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const BTN_APPROVE =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press hover:opacity-90 disabled:opacity-40";
const BTN_DENY =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-failed)] aos-press hover:bg-failed-tint disabled:opacity-40";
const BTN_REVIEW =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-needs px-4 text-sm font-semibold text-ink aos-press hover:opacity-90 disabled:opacity-40";
const BTN_EXEC =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-failed px-4 text-sm font-semibold text-white aos-press hover:bg-failed/90 disabled:opacity-40";
const INPUT_CLS =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

// Risk tiers are categories, not agent states — always a neutral chip.
function tierBadge(tier: string) {
  return <span className={chipNeutral}>{tier}</span>;
}

// Approval/execution states ARE agent states — status-color badges.
function statusBadge(status: string) {
  const cls =
    status === "connected" || status === "approved" || status === "success" || status === "executed"
      ? "bg-done text-white"
      : status === "pending"
        ? "bg-needs text-ink"
        : status === "denied" || status === "failed"
          ? "bg-failed text-white"
          : "";
  if (!cls) return <span className={chipNeutral}>{status}</span>;
  return <span className={`${badgeBase} ${cls}`}>{status}</span>;
}

/** Category badge for the toolkit directory — neutral, never a primary. */
function categoryBadge(category: string) {
  return <span className={chipNeutral}>{category}</span>;
}

/** Tier breakdown cells for the toolkit directory — tiers are categories,
 *  so every cell is a neutral chip; unclassified keeps its dashed marker. */
function tierBreakdownBadges(bd: ToolkitEntry["tierBreakdown"]) {
  const items: Array<{ label: string; n: number }> = [
    { label: "low", n: bd.low },
    { label: "medium", n: bd.medium },
    { label: "high", n: bd.high },
    { label: "unclassified", n: bd.unclassified },
  ];
  return (
    <div className="flex flex-wrap gap-1">
      {items.map((it) => (
        <span
          key={it.label}
          title={`${it.n} ${it.label} tools`}
          className={
            it.label === "unclassified"
              ? "inline-block rounded-full border border-dashed border-line bg-paper px-1.5 py-0.5 text-[11px] font-medium text-muted"
              : chipNeutral
          }
        >
          {it.label} {it.n}
        </span>
      ))}
    </div>
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

function BudgetPanel({
  budget,
  attribution,
}: {
  budget: WorkspaceBudgetCheck;
  attribution: ToolkitAttribution;
}) {
  const entries = Object.entries(attribution.byToolkit).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 8);
  return (
    <div className="mb-3 rounded-lg border border-line bg-paper px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-[12px] font-semibold text-muted">Call budget</span>
        {budget.budget == null ? (
          <span className="text-[12px] text-muted">
            No monthly budget set — usage is metered through the credit ledger.
          </span>
        ) : (
          <>
            <span className="text-[12px] text-muted">
              {budget.usage.toLocaleString()} / {budget.budget.toLocaleString()} calls this month (
              {budget.pct}%)
            </span>
            <span
              className={budget.hardCap ? "inline-flex items-center rounded-full bg-failed-tint px-2 py-0.5 text-[11px] font-medium text-failed-text" : chipNeutral}
            >
              {budget.hardCap ? "Hard cap" : "Soft cap"}
            </span>
            {budget.blocked && (
              <span className="flex items-center gap-1 text-[12px] font-medium text-failed-text">
                <AlertTriangle className="h-3.5 w-3.5" /> Budget exhausted — new executions are
                refused.
              </span>
            )}
          </>
        )}
      </div>
      {budget.budget != null && (
        <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line">
          <div
            className="h-full rounded-full bg-ink"
            style={{ width: `${Math.min(100, budget.pct)}%` }}
          />
        </div>
      )}
      {budget.warning && (
        <div className="mt-2 flex items-start gap-2 rounded-md border border-line bg-needs-tint px-3 py-2 text-[12px] text-ink">
          <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0" role="img" aria-label="Warning" />
          <span>{budget.warning}</span>
        </div>
      )}
      {top.length > 0 && (
        <div className="mt-3 border-t border-line pt-2">
          <div className="mb-1.5 text-[11px] font-semibold text-muted">
            Cost attribution — this month
          </div>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {top.map(([slug, count]) => {
              const pct =
                attribution.total > 0 ? Math.round((count / attribution.total) * 100) : 0;
              return (
                <div key={slug} className="flex items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-[12px] font-medium text-muted">
                    {slug === "unknown" ? "Unattributed" : slug}
                  </span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line">
                    <div
                      className="h-full rounded-full bg-ink/70"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="w-24 shrink-0 text-right text-[11px] text-muted">
                    {pct}% · {count.toLocaleString()}
                  </span>
                </div>
              );
            })}
          </div>
          {entries.length > top.length && (
            <div className="mt-1 text-[11px] text-subtle">
              + {entries.length - top.length} more toolkits
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Phase 15 slice 5: catalog drift panel (spec §1, §6).
// Sits in Actions → Activity next to the BudgetPanel. Unacknowledged
// drift reports land here with per-change badges; acknowledging is the
// human's re-approval (clears the banner count + any stale-override
// flag for that slug). Stale tier overrides surface as a "re-approve"
// affordance — the override points at a removed/renamed slug, so the
// human re-points it before clearing.
// House pattern: info-note container, dense table with badge columns,
// brand-var buttons.
// ─────────────────────────────────────────────────────────────────────
// Catalog drift changes are document states — removed reads as failed,
// renamed as needs review, added as informational neutral.
function driftBadge(changeType: DriftReportRow["changeType"]) {
  const cls =
    changeType === "removed"
      ? "bg-failed text-white"
      : changeType === "renamed"
        ? "bg-needs text-ink"
        : "";
  if (!cls) return <span className={chipNeutral}>{changeType}</span>;
  return <span className={`${badgeBase} ${cls}`}>{changeType}</span>;
}

function driftDetail(r: DriftReportRow): string {
  if (r.changeType === "added")
    return "New in the live catalog — not in the cache; proposals land high-gated until classified.";
  if (r.changeType === "removed")
    return "Gone from the live catalog — the last-known cache row is kept; proposals on this slug fail closed.";
  return `Was ${r.oldSlug} — re-point any override at the new slug before re-approving.`;
}

function DriftPanel({
  data,
  onAcknowledge,
}: {
  data: DriftState | null;
  onAcknowledge: (driftId: string) => Promise<void>;
}) {
  if (data === null) return null;
  const unack = data.reports.filter((r) => r.acknowledgedAt === null);
  return (
    <div className="mb-3 rounded-lg border border-line bg-paper px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="text-[12px] font-semibold text-muted">Catalog drift</span>
        {unack.length === 0 ? (
          <span className="text-[12px] text-muted">
            Live catalog matches the cached tool list — no drift detected.
          </span>
        ) : (
          <span className="flex items-center gap-1.5 rounded-md border border-line bg-needs-tint px-2 py-1 text-[12px] font-medium text-ink">
            <span className="aos-shape aos-shape--needs aos-shape--edged shrink-0" role="img" aria-label="Warning" />
            {unack.length} unacknowledged change{unack.length === 1 ? "" : "s"}
          </span>
        )}
      </div>
      {unack.length > 0 && (
        <div className="mt-2 overflow-hidden rounded-lg border border-line bg-paper">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="border-b border-line bg-paper text-left text-[11px] text-muted">
                <th className="px-3 py-2 font-medium">Detected</th>
                <th className="px-3 py-2 font-medium">Change</th>
                <th className="px-3 py-2 font-medium">Tool</th>
                <th className="px-3 py-2 font-medium">What changed</th>
                <th className="px-3 py-2 font-medium">Re-approve</th>
              </tr>
            </thead>
            <tbody>
              {unack.map((r) => (
                <tr key={r.id} className="border-b border-line hover:bg-hover-paper">
                  <td className="whitespace-nowrap px-3 py-2 text-muted">
                    {new Date(r.detectedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2">{driftBadge(r.changeType)}</td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted">{r.toolSlug}</td>
                  <td className="max-w-[320px] px-3 py-2 text-muted">{driftDetail(r)}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onAcknowledge(r.id)}
                      className={BTN_REVIEW}
                    >
                      Re-approve
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.staleOverrides.length > 0 && (
        <div className="mt-2 border-t border-line pt-2">
          <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-ink">
            <span className="aos-shape aos-shape--needs aos-shape--edged shrink-0" role="img" aria-label="Needs re-approval" />
            Stale tier overrides — needs re-approval
          </div>
          <div className="grid gap-1.5">
            {data.staleOverrides.map((s) => {
              const row = unack.find(
                (r) =>
                  (r.changeType === "removed" && r.toolSlug === s.toolSlug) ||
                  (r.changeType === "renamed" && r.oldSlug === s.toolSlug),
              );
              return (
                <div key={s.toolSlug} className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] font-medium text-muted">
                    {s.toolSlug}
                  </span>
                  <span className="flex-1 text-[12px] text-muted">{s.reason}</span>
                  {row && (
                    <button
                      onClick={() => onAcknowledge(row.id)}
                      className={BTN_REVIEW}
                    >
                      Re-approve
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ActionsClient
// ─────────────────────────────────────────────────────────────────────
export function ActionsClient({
  apps,
  initialConnections,
  initialApprovals,
  initialLogs,
  initialToolkits,
  initialBudget,
  initialAttribution,
}: {
  apps: AppDef[];
  initialConnections: Connection[];
  initialApprovals: Approval[];
  initialLogs: ActionLog[];
  initialToolkits: ToolkitEntry[];
  initialBudget: WorkspaceBudgetCheck;
  initialAttribution: ToolkitAttribution;
}) {
  const [tab, setTab] = useState<Tab>("approvals");
  const [connections, setConnections] = useState(initialConnections);
  const [approvals, setApprovals] = useState(initialApprovals);
  const [logs, setLogs] = useState(initialLogs);
  const [toolkits, setToolkits] = useState(initialToolkits);
  const [toolkitSearch, setToolkitSearch] = useState("");
  const [toolkitCategory, setToolkitCategory] = useState("all");
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
  // Phase 15 slice 5: catalog drift panel state (fetched client-side; the
  // panel lives in the Activity tab next to the BudgetPanel).
  const [drift, setDrift] = useState<DriftState | null>(null);
  async function refreshDrift() {
    try {
      const data = await api("/api/integrations/actions/drift");
      setDrift({
        reports: (data.reports as DriftReportRow[]) ?? [],
        unacknowledgedCount: Number(data.unacknowledgedCount ?? 0),
        staleOverrides: (data.staleOverrides as StaleOverrideRow[]) ?? [],
      });
    } catch {
      // Actions is still usable without drift data; leave the panel hidden.
    }
  }
  useEffect(() => {
    refreshDrift();
  }, []);
  async function acknowledgeDrift(driftId: string) {
    try {
      setError(null);
      await api("/api/integrations/actions/drift", {
        method: "POST",
        body: JSON.stringify({ driftId }),
      });
      await refreshDrift();
    } catch (e) {
      setError((e as Error).message);
    }
  }
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
    const [c, a, l, t] = await Promise.all([
      api("/api/integrations/actions/connections"),
      api("/api/integrations/actions/approvals?status=all"),
      api("/api/integrations/actions/activity"),
      api("/api/integrations/actions/toolkits"),
    ]);
    setConnections(c.connections as Connection[]);
    setApprovals(a.approvals as Approval[]);
    setLogs(l.logs as ActionLog[]);
    setToolkits(t.toolkits as ToolkitEntry[]);
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

  /** Phase 15 slice 3: per-toolkit enable/disable (à la carte, no packs).
   *  Agents can only propose tools from enabled toolkits; the gate refuses
   *  anything else fail-closed. */
  async function toggleToolkit(toolkitSlug: string, enabled: boolean) {
    await run(`toggle-${toolkitSlug}`, async () => {
      await api("/api/integrations/actions/toolkits", {
        method: "POST",
        body: JSON.stringify({ toolkitSlug, enabled }),
      });
    });
  }

  const visibleToolkits = useMemo(() => {
    const q = toolkitSearch.trim().toLowerCase();
    return toolkits.filter(
      (t) =>
        (toolkitCategory === "all" || t.category === toolkitCategory) &&
        (!q ||
          t.label.toLowerCase().includes(q) ||
          t.toolkitSlug.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q)),
    );
  }, [toolkits, toolkitSearch, toolkitCategory]);

  const enabledToolkitCount = toolkits.filter((t) => t.enabled).length;

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
      <div className="flex gap-1 border-b border-line">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13px] font-medium ${
                active
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4" />
              {t.label}
              {t.id === "approvals" && pendingCount > 0 && (
                <span className="rounded-full bg-ink px-1.5 text-[11px] font-semibold text-white">
                  {pendingCount}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-failed bg-failed-tint px-3 py-2 text-[13px] text-failed-text">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Connections ─────────────────────────────────────────── */}
      {tab === "connections" && (
        <div className="overflow-hidden rounded-lg border border-line bg-paper">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-paper text-left text-[11px] text-muted">
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
                  <tr key={app.appKey} className="border-b border-line hover:bg-hover-paper">
                    <td className="px-3 py-2.5 font-medium text-ink">{app.label}</td>
                    <td className="px-3 py-2.5 text-muted">{app.description}</td>
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
                          className={BTN_SECONDARY}
                        >
                          {busy === `revoke-${conn.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Revoke"}
                        </button>
                      ) : (
                        <button
                          disabled={busy === `connect-${app.appKey}`}
                          onClick={() => connect(app.appKey)}
                          className={BTN_PRIMARY}
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
          <div className="border-t border-line bg-paper px-3 py-2 text-[12px] text-muted">
            OAuth runs on Composio&apos;s hosted flow — Marketr stores only the connection
            reference, never your app tokens.
          </div>
        </div>
      )}

      {/* ── Toolkits (Phase 15 slice 3) ─────────────────────────────── */}
      {tab === "toolkits" && (
        <div className="flex flex-col gap-3">
          {/* Filter toolbar: search + category dropdown (house pattern) */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
              <input
                value={toolkitSearch}
                onChange={(e) => setToolkitSearch(e.target.value)}
                placeholder="Search toolkits…"
                aria-label="Search toolkits"
                className={`${INPUT_CLS} pl-8 pr-2`}
              />
            </div>
            <select
              value={toolkitCategory}
              onChange={(e) => setToolkitCategory(e.target.value)}
              aria-label="Filter by category"
              className={INPUT_CLS}
            >
              <option value="all">All categories</option>
              {TOOLKIT_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <span className="text-[12px] text-muted">
              {enabledToolkitCount} of {toolkits.length} enabled — agents can only
              propose tools from enabled toolkits; anything else is refused by
              the gate.
            </span>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-paper">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-paper text-left text-[11px] text-muted">
                  <th className="px-3 py-2 font-medium">Toolkit</th>
                  <th className="px-3 py-2 font-medium">Category</th>
                  <th className="px-3 py-2 font-medium">Tools</th>
                  <th className="px-3 py-2 font-medium">Tier breakdown</th>
                  <th className="px-3 py-2 font-medium">Connection</th>
                  <th className="px-3 py-2 font-medium">Enabled</th>
                  <th className="px-3 py-2 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {visibleToolkits.map((t) => (
                  <tr key={t.toolkitSlug} className="border-b border-line hover:bg-hover-paper">
                    <td className="max-w-xs px-3 py-2.5">
                      <div className="font-medium text-ink">{t.label}</div>
                      <div className="text-[12px] text-muted">{t.description}</div>
                    </td>
                    <td className="px-3 py-2.5">{categoryBadge(t.category)}</td>
                    <td className="px-3 py-2.5 text-muted">{t.toolCount}</td>
                    <td className="px-3 py-2.5">{tierBreakdownBadges(t.tierBreakdown)}</td>
                    <td className="px-3 py-2.5">
                      {statusBadge(t.connected ? "connected" : "not connected")}
                    </td>
                    <td className="px-3 py-2.5">
                      <button
                        role="switch"
                        aria-checked={t.enabled}
                        aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.label} toolkit`}
                        disabled={busy === `toggle-${t.toolkitSlug}`}
                        onClick={() => toggleToolkit(t.toolkitSlug, !t.enabled)}
                        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                          t.enabled ? "bg-ink" : "bg-disabled-fg"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-paper shadow transition-transform ${
                            t.enabled ? "translate-x-4" : "translate-x-0.5"
                          }`}
                        />
                      </button>
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {!t.connected ? (
                        <button
                          disabled={busy === `connect-${t.appKey}`}
                          onClick={() => connect(t.appKey)}
                          className={BTN_PRIMARY}
                        >
                          {busy === `connect-${t.appKey}` ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <ExternalLink className="h-3.5 w-3.5" />
                          )}
                          Connect
                        </button>
                      ) : (
                        <span className="text-[12px] text-subtle">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {visibleToolkits.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-[13px] text-subtle">
                      No toolkits match — try a different search or category.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            <div className="border-t border-line bg-paper px-3 py-2 text-[12px] text-muted">
              Every toolkit is browsable from day one (full firehose, no packs).
              Enablement is à la carte; unclassified tools always land
              high-gated and need your approval plus second confirmation.
            </div>
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
              className={INPUT_CLS}
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
                className={BTN_APPROVE}
              >
                {busy === "batch" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                Approve {selected.size} selected
              </button>
            )}
            <span className="text-[12px] text-muted">
              Approvals expire automatically — stale proposals can never execute.
            </span>
          </div>

          <div className="overflow-hidden rounded-lg border border-line bg-paper">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line bg-paper text-left text-[11px] text-muted">
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
                    <tr className="border-b border-line hover:bg-hover-paper">
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
                            className="h-3.5 w-3.5 accent-ink"
                          />
                        )}
                      </td>
                      <td className="max-w-md px-3 py-2.5 text-ink">{a.plainSummary}</td>
                      <td className="px-3 py-2.5 font-mono text-[11px] text-muted">{a.toolName}</td>
                      <td className="px-3 py-2.5">{tierBadge(a.riskTier)}</td>
                      <td className="px-3 py-2.5">{statusBadge(a.status)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex justify-end gap-1.5">
                          <button
                            onClick={() => openDetail(a.id)}
                            className={BTN_SECONDARY}
                          >
                            {expanded === a.id ? "Hide" : "Details"}
                          </button>
                          {a.status === "pending" && (
                            <>
                              <button
                                disabled={busy === `decide-${a.id}`}
                                onClick={() => decide(a.id, "approved")}
                                aria-label={`Approve ${a.toolName}`}
                                className={BTN_APPROVE}
                              >
                                <Check className="h-3.5 w-3.5" /> Approve
                              </button>
                              <button
                                disabled={busy === `decide-${a.id}`}
                                onClick={() => setDenyFor(a.id)}
                                aria-label={`Deny ${a.toolName}`}
                                className={BTN_DENY}
                              >
                                <X className="h-3.5 w-3.5" /> Deny
                              </button>
                            </>
                          )}
                          {a.status === "approved" && a.riskTier !== "high" && (
                            <button
                              disabled={busy === `exec-${a.id}`}
                              onClick={() => executeApproval(a)}
                              className={BTN_SECONDARY}
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
                              className={BTN_DENY}
                            >
                              <AlertTriangle className="h-3.5 w-3.5" />
                              Execute
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {confirmExec === a.id && a.status === "approved" && a.riskTier === "high" && (
                      <tr key={`${a.id}-confirm`} className="border-b border-failed bg-failed-tint">
                        <td />
                        <td colSpan={5} className="px-3 py-3">
                          {(() => {
                            const bulk = bulkFor(a);
                            return (
                              <div className="rounded-md border border-failed bg-paper p-3">
                                <div className="flex items-center gap-1.5 text-[13px] font-semibold text-failed-text">
                                  <AlertTriangle className="h-4 w-4" />
                                  Destructive action — explicit confirmation required
                                </div>
                                <div className="mt-1 text-[12px] text-muted">{a.plainSummary}</div>
                                {bulk ? (
                                  <div className="mt-1 text-[12px] font-medium text-failed-text">
                                    Bulk review: {describeBulk(bulk)}
                                  </div>
                                ) : (
                                  <div className="mt-1 text-[12px] text-muted">
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
                                    className={BTN_EXEC}
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
                                    className={BTN_SECONDARY}
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
                      <tr key={`${a.id}-detail`} className="border-b border-line bg-paper/60">
                        <td />
                        <td colSpan={5} className="px-3 py-3">
                          <div className="grid gap-3 md:grid-cols-2">
                            <div>
                              <div className="mb-1 text-[11px] font-medium text-muted">
                                Proposed arguments (redacted)
                              </div>
                              <pre className="max-h-48 overflow-auto rounded-md border border-line bg-paper p-2 font-mono text-[11px] text-muted">
                                {JSON.stringify((detail as { proposedArgs?: unknown }).proposedArgs ?? {}, null, 2)}
                              </pre>
                              {editing === a.id ? (
                                <div className="mt-2">
                                  <textarea
                                    value={editText}
                                    onChange={(e) => setEditText(e.target.value)}
                                    rows={6}
                                    className={`${INPUT_CLS} h-auto py-2 font-mono text-[11px]`}
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
                                      className={BTN_APPROVE}
                                    >
                                      Approve with edits
                                    </button>
                                    <button
                                      onClick={() => setEditing(null)}
                                      className={BTN_SECONDARY}
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
                                    className="mt-2 inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[12px] text-muted hover:bg-paper"
                                  >
                                    <Pencil className="h-3.5 w-3.5" /> Edit args before approving
                                  </button>
                                )
                              )}
                            </div>
                            <div>
                              <div className="mb-1 text-[11px] font-medium text-muted">
                                Audit trail
                              </div>
                              <ul className="space-y-1 text-[12px] text-muted">
                                {((detail as { auditTrail?: Array<{ at: string; actor: string; event: string; detail?: string }> }).auditTrail ?? []).map(
                                  (ev, i) => (
                                    <li key={i} className="rounded border border-line bg-paper px-2 py-1">
                                      <span className="font-medium text-ink">{ev.event}</span>
                                      <span className="text-subtle"> · {ev.actor}</span>
                                      {ev.detail && <div className="text-muted">{ev.detail}</div>}
                                    </li>
                                  ),
                                )}
                              </ul>
                              {a.decisionReason && (
                                <div className="mt-2 text-[12px] text-muted">
                                  <span className="font-medium">Decision reason:</span> {a.decisionReason}
                                </div>
                              )}
                            </div>
                          </div>
                          {denyFor === a.id && (
                            <div className="mt-3 rounded-md border border-failed bg-failed-tint/50 p-2">
                              <div className="mb-1 text-[12px] font-medium text-failed-text">
                                Deny with reason (the action is killed):
                              </div>
                              <div className="flex gap-1.5">
                                <input
                                  value={denyReason}
                                  onChange={(e) => setDenyReason(e.target.value)}
                                  placeholder="Why is this denied?"
                                  className={`${INPUT_CLS} flex-1 text-[12px]`}
                                />
                                <button
                                  onClick={() => decide(a.id, "denied", denyReason || "Denied without reason")}
                                  className={BTN_EXEC}
                                >
                                  Confirm deny
                                </button>
                                <button
                                  onClick={() => setDenyFor(null)}
                                  className={BTN_SECONDARY}
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
                    <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-subtle">
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
        <>
          <DriftPanel data={drift} onAcknowledge={acknowledgeDrift} />
          <BudgetPanel budget={initialBudget} attribution={initialAttribution} />
          <div className="overflow-hidden rounded-lg border border-line bg-paper">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-line bg-paper text-left text-[11px] text-muted">
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
                <tr key={l.id} className="border-b border-line hover:bg-hover-paper">
                  <td className="whitespace-nowrap px-3 py-2.5 text-muted">
                    {new Date(l.createdAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2.5 font-mono text-[11px] text-muted">{l.toolName}</td>
                  <td className="px-3 py-2.5 text-muted">{l.appKey}</td>
                  <td className="px-3 py-2.5">{tierBadge(l.riskTier)}</td>
                  <td className="px-3 py-2.5">{statusBadge(l.status)}</td>
                  <td className="max-w-[180px] truncate px-3 py-2.5 text-muted">{l.executedBy}</td>
                </tr>
              ))}
              {logs.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-8 text-center text-[13px] text-subtle">
                    No actions executed yet — every execution is logged here.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <div className="border-t border-line bg-paper px-3 py-2 text-[12px] text-muted">
            Reads and draft-creators execute automatically and appear here; writes and
            destructive actions only after your approval.
          </div>
          </div>
        </>
      )}
    </div>
  );
}
