// Marketr — Mission detail client (Phase 9, M4).
// Header (goal, status, progress) + icon sub-tabs (Timeline | Approvals | Plan),
// dense event timeline, approval queue with Approve/Deny, pause/resume.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MarketrAgentShell } from "@/components/agents/MarketrAgentShell";
import {
  Check,
  ChevronLeft,
  ExternalLink,
  History,
  KanbanSquare,
  ListChecks,
  Loader2,
  Pause,
  Play,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const j = (await r.json().catch(() => ({}))) as { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j as T;
}

// ── Atoms (Agentic OS) ───────────────────────────────────────────────────────

// Categories (business type, tier, executor, kind, state groups) are not agent
// states — always a neutral chip.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      {children}
    </span>
  );
}

const badgeBase =
  "inline-flex h-badge items-center gap-1.5 rounded-full px-3 text-sm font-semibold";

function Shape({ extra, size }: { extra: string; size?: string }) {
  return (
    <span
      className={`aos-shape ${extra}${size ? ` [--aos-shape-size:${size}]` : ""}`}
      style={{ color: "inherit" }}
      aria-hidden
    />
  );
}

function MissionStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "active":
      return (
        <span className={`${badgeBase} bg-running text-white`}>
          <Shape extra="aos-shape--running aos-is-live" /> Active
        </span>
      );
    case "paused":
      return (
        <span className={`${badgeBase} bg-line text-ink`}>
          <Shape extra="aos-shape--paused" /> Paused
        </span>
      );
    case "complete":
      return (
        <span className={`${badgeBase} bg-done text-white`}>
          <Shape extra="aos-shape--done" /> Complete
        </span>
      );
    case "planned":
      return (
        <span className={`${badgeBase} bg-paper text-ink shadow-outline`}>
          <Shape extra="aos-shape--queued" /> Planned
        </span>
      );
    default:
      return (
        <span className="inline-flex h-badge items-center rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
          Archived
        </span>
      );
  }
}

// Approval decisions are genuine agent states: pending needs you, approved is
// done, denied failed, expired is just a shelf.
function ApprovalStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "pending":
      return (
        <span className={`${badgeBase} bg-needs text-ink`}>
          <Shape extra="aos-shape--needs" /> Pending
        </span>
      );
    case "approved":
      return (
        <span className={`${badgeBase} bg-done text-white`}>
          <Shape extra="aos-shape--done" /> Approved
        </span>
      );
    case "denied":
      return (
        <span className={`${badgeBase} bg-failed text-white`}>
          <Shape extra="aos-shape--failed" /> Denied
        </span>
      );
    default:
      return (
        <span className="inline-flex h-badge items-center rounded-full bg-paper px-3 text-sm font-semibold text-muted shadow-control">
          Expired
        </span>
      );
  }
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
      <span className="mt-1 size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnDeny =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-failed-text aos-press shadow-[inset_0_0_0_1.5px_var(--aos-failed)] disabled:opacity-40";
const btnApprove =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-done px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";
const btnRun =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";

// ── Types ────────────────────────────────────────────────────────────────────

interface DetailEvent {
  id: string;
  ts: string;
  actor: string;
  step: string | null;
  tool: string | null;
  args: Record<string, unknown>;
  observation: Record<string, unknown>;
  costCents: number;
}

interface DetailApproval {
  id: string;
  action: string;
  tier: number;
  bindingJson: Record<string, unknown>;
  bindingHash: string;
  status: string;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string | null;
  createdBy: string;
  createdAt: string;
}

interface PlanStep {
  order: number;
  key: string;
  title: string;
  kind: string;
  executor: string;
  description: string;
  tier: number;
  checkpointAfter: boolean;
}

interface MissionDetailData {
  mission: {
    id: string;
    name: string;
    template: string;
    businessTypeLabel: string;
    status: string;
    goal: { metric?: string; targetValue?: number; unit?: string; timeframeDays?: number; direction?: string; label?: string };
    planSnapshot: { steps?: PlanStep[] };
    termination: { deadlineAt?: string; maxCostCents?: number; maxSteps?: number };
  };
  events: DetailEvent[];
  approvals: DetailApproval[];
  stepCount: number;
  planStepCount: number;
  totalCostCents: number;
  progress: number;
  termination: { done: boolean; reason: string | null };
  nextCheckpoint: string | null;
}

function summarizeObservation(obs: Record<string, unknown>): string {
  if (!obs || typeof obs !== "object") return "—";
  const o = obs as Record<string, unknown>;
  if (typeof o.summary === "string") return o.summary;
  if (typeof o.note === "string") return o.note;
  if (typeof o.reason === "string") return `reason: ${o.reason}`;
  if (typeof o.decision === "string") return `decision: ${o.decision}`;
  const keys = Object.keys(o);
  if (keys.length === 0) return "—";
  const s = JSON.stringify(o);
  return s.length > 110 ? `${s.slice(0, 110)}…` : s;
}

function fmtCost(cents: number): string {
  return cents === 0 ? "—" : `$${(cents / 100).toFixed(2)}`;
}

// ── Sub-tab panels ───────────────────────────────────────────────────────────

function TimelineTab({ events }: { events: DetailEvent[] }) {
  if (events.length === 0) {
    return <p className="py-8 text-center text-sm text-subtle">No events yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            <th className="px-3 py-2 font-semibold">Time</th>
            <th className="px-3 py-2 font-semibold">Step</th>
            <th className="px-3 py-2 font-semibold">Actor</th>
            <th className="px-3 py-2 font-semibold">Tool</th>
            <th className="px-3 py-2 font-semibold">Observation</th>
            <th className="px-3 py-2 text-right font-semibold">Cost</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted">
                {new Date(e.ts).toLocaleString()}
              </td>
              <td className="px-3 py-2 font-mono text-xs text-ink">{e.step ?? "—"}</td>
              <td className="px-3 py-2 text-muted">{e.actor}</td>
              <td className="px-3 py-2 font-mono text-xs text-muted">{e.tool ?? "—"}</td>
              <td className="max-w-[380px] truncate px-3 py-2 text-muted" title={summarizeObservation(e.observation)}>
                {summarizeObservation(e.observation)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-muted">{fmtCost(e.costCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ApprovalsTab({
  missionId,
  approvals,
  onDecided,
}: {
  missionId: string;
  approvals: DetailApproval[];
  onDecided: () => void;
}) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useMemo(() => approvals.filter((a) => a.status === "pending"), [approvals]);
  const decided = useMemo(() => approvals.filter((a) => a.status !== "pending"), [approvals]);

  async function decide(approvalId: string, decision: "approved" | "denied") {
    setBusyId(approvalId);
    setError(null);
    try {
      await api(`/api/missions/${missionId}/approvals/${approvalId}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision }),
      });
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-4">
      {error && <ErrorBox message={error} />}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-xs font-semibold text-muted">Pending</span>
          {pending.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-needs px-2 py-0.5 text-xs font-semibold text-ink">
              <Shape extra="aos-shape--needs" size="8px" />
              {pending.length}
            </span>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="rounded-lg bg-paper px-3 py-6 text-center text-sm text-subtle shadow-hairline">
            No pending approvals — nothing is waiting on you.
          </p>
        ) : (
          <div className="space-y-2">
            {pending.map((a) => (
              <div key={a.id} className="rounded-lg bg-needs px-3.5 py-3 text-ink">
                <div className="flex flex-wrap items-center gap-2">
                  <Shape extra="aos-shape--needs" size="12px" />
                  <span className="text-sm font-semibold">{a.action}</span>
                  <Chip>Tier {a.tier}</Chip>
                  <span className="ml-auto text-xs">
                    expires {a.expiresAt ? new Date(a.expiresAt).toLocaleString() : "—"}
                  </span>
                </div>
                <div className="mt-1.5 max-w-full overflow-hidden text-ellipsis font-mono text-[11px]">
                  {JSON.stringify(a.bindingJson)}
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button onClick={() => void decide(a.id, "approved")} disabled={busyId !== null} className={btnApprove}>
                    {busyId === a.id ? <Loader2 size={14} className="aos-spin" /> : <Check size={14} />} Approve
                  </button>
                  <button onClick={() => void decide(a.id, "denied")} disabled={busyId !== null} className={btnDeny}>
                    {busyId === a.id ? <Loader2 size={14} className="aos-spin" /> : <X size={14} />} Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {decided.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-semibold text-muted">Decided</div>
          <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead>
                <tr className="border-b border-line text-xs font-semibold text-muted">
                  <th className="px-3 py-2 font-semibold">Action</th>
                  <th className="px-3 py-2 font-semibold">Tier</th>
                  <th className="px-3 py-2 font-semibold">Decision</th>
                  <th className="px-3 py-2 font-semibold">Decided by</th>
                  <th className="px-3 py-2 font-semibold">Decided at</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((a) => (
                  <tr key={a.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                    <td className="px-3 py-2 font-medium text-ink">{a.action}</td>
                    <td className="px-3 py-2"><Chip>Tier {a.tier}</Chip></td>
                    <td className="px-3 py-2"><ApprovalStatusBadge status={a.status} /></td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-muted" title={a.decidedBy ?? ""}>{a.decidedBy ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-xs tabular-nums text-muted">
                      {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanTab({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) {
    return <p className="py-8 text-center text-sm text-subtle">No plan steps.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            <th className="px-3 py-2 font-semibold">#</th>
            <th className="px-3 py-2 font-semibold">Step</th>
            <th className="px-3 py-2 font-semibold">Executor</th>
            <th className="px-3 py-2 font-semibold">Kind</th>
            <th className="px-3 py-2 font-semibold">Tier</th>
            <th className="px-3 py-2 font-semibold">Checkpoint</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.key} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="px-3 py-2 tabular-nums text-subtle">{s.order}</td>
              <td className="px-3 py-2">
                <div className="font-medium text-ink">{s.title}</div>
                <div className="text-xs text-muted">{s.description}</div>
              </td>
              <td className="px-3 py-2"><Chip>{s.executor}</Chip></td>
              <td className="px-3 py-2"><Chip>{s.kind}</Chip></td>
              <td className="px-3 py-2"><Chip>Tier {s.tier}</Chip></td>
              <td className="px-3 py-2">
                {s.checkpointAfter ? <Check size={14} className="text-ink" /> : <span className="text-subtle">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Tasks tab (Phase 12: Plane sidecar) ──────────────────────────────────────
// Live Plane issues for a chosen project, surfaced inside the mission.
// Honest unconfigured state — never fabricated tasks.

interface PlaneProject {
  id: string;
  name: string;
  identifier: string;
}

interface PlaneIssueRow {
  id: string;
  name: string;
  sequenceId: number | null;
  state: string | null;
  stateGroup: string | null;
  priority: string | null;
  labels: string[];
  url: string | null;
  updatedAt: string | null;
}

function TasksTab() {
  const [projects, setProjects] = useState<PlaneProject[] | null>(null);
  const [projectId, setProjectId] = useState("");
  const [issues, setIssues] = useState<PlaneIssueRow[] | null>(null);
  const [openCount, setOpenCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ projects: PlaneProject[] }>(
          "/api/integrations/plane/projects",
        );
        setProjects(r.projects);
        if (r.projects.length > 0) setProjectId(r.projects[0].id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Load failed.";
        if (/isn't connected|not connected|not_configured/i.test(msg)) setNotConfigured(true);
        else setError(msg);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!projectId) {
      setIssues(null);
      return;
    }
    (async () => {
      setLoadingIssues(true);
      try {
        const r = await api<{ issues: PlaneIssueRow[]; openCount: number }>(
          `/api/integrations/plane/issues?projectId=${encodeURIComponent(projectId)}`,
        );
        setIssues(r.issues);
        setOpenCount(r.openCount);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Load failed.");
      } finally {
        setLoadingIssues(false);
      }
    })();
  }, [projectId]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 py-8 text-sm text-muted">
        <Loader2 size={14} className="aos-spin" /> Loading Plane tasks…
      </p>
    );
  }

  if (notConfigured) {
    return (
      <div className="rounded-lg bg-paper px-4 py-6 text-center shadow-hairline">
        <KanbanSquare className="mx-auto h-6 w-6 text-subtle" />
        <p className="mt-2 text-sm font-medium text-ink">Plane isn&apos;t connected</p>
        <p className="mt-1 text-sm text-muted">
          Set <span className="font-mono text-xs">PLANE_BASE_URL</span>,{" "}
          <span className="font-mono text-xs">PLANE_API_KEY</span> and{" "}
          <span className="font-mono text-xs">PLANE_WORKSPACE_SLUG</span> under{" "}
          <Link href="/dashboard/settings/providers" className="text-ink underline hover:text-focus">
            Settings → Providers
          </Link>{" "}
          to sync project tasks into this mission.
        </p>
      </div>
    );
  }

  if (error) {
    return <div className="mb-3"><ErrorBox message={error} /></div>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className={inputCls}
          aria-label="Plane project"
        >
          {(projects ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}{p.identifier ? ` (${p.identifier})` : ""}
            </option>
          ))}
        </select>
        {issues && (
          <span className="text-xs text-muted">
            {openCount} open · {issues.length} total
          </span>
        )}
        {loadingIssues && <Loader2 size={14} className="aos-spin text-subtle" />}
      </div>
      {!issues || issues.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">
          {issues ? "No issues in this project." : "Pick a project to load its tasks."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-line text-xs font-semibold text-muted">
                <th className="px-3 py-2 font-semibold">Task</th>
                <th className="px-3 py-2 font-semibold">State</th>
                <th className="px-3 py-2 font-semibold">Priority</th>
                <th className="px-3 py-2 font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((t) => (
                <tr key={t.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    {t.url ? (
                      <a
                        href={t.url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 font-medium text-ink hover:text-focus hover:underline"
                      >
                        {t.sequenceId !== null && (
                          <span className="text-subtle">#{t.sequenceId}</span>
                        )}{" "}
                        {t.name}
                        <ExternalLink size={12} className="text-subtle" />
                      </a>
                    ) : (
                      <span className="font-medium text-ink">{t.name}</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <Chip>{t.state ?? "—"}</Chip>
                  </td>
                  <td className="px-3 py-2 text-muted">{t.priority ?? "—"}</td>
                  <td className="px-3 py-2 text-muted">
                    {t.updatedAt ? new Date(t.updatedAt).toLocaleDateString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-[11px] leading-snug text-subtle">
        Live from your Plane sidecar — tasks are managed in Plane; this tab is a
        read-only window into the selected project.
      </p>
    </div>
  );
}

// ── Detail shell ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "timeline", label: "Timeline", icon: History },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "tasks", label: "Tasks", icon: KanbanSquare },
] as const;

export function MissionDetail({ missionId }: { missionId: string }) {
  const [data, setData] = useState<MissionDetailData | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("timeline");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [showAutomation, setShowAutomation] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await api<MissionDetailData>(`/api/missions/${missionId}`);
      setData(r);
      setNotFound(false);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Load failed.";
      if (/not found/i.test(msg)) setNotFound(true);
      else setError(msg);
    } finally {
      setLoading(false);
    }
  }, [missionId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function pauseResume(action: "pause" | "resume") {
    setBusy(action);
    setError(null);
    try {
      const r = await api<{ ok: boolean; staleness?: { fresh: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> } }>(
        `/api/missions/${missionId}/${action}`,
        { method: "POST" },
      );
      if (action === "resume" && r.staleness && !r.staleness.fresh) {
        setError("Stale — mission stays paused. Human review required.");
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : `${action} failed.`);
    } finally {
      setBusy(null);
    }
  }

  const pendingCount = useMemo(
    () => (data?.approvals ?? []).filter((a) => a.status === "pending").length,
    [data],
  );

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-sm text-muted">
        <Loader2 size={16} className="aos-spin" /> Loading mission…
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="py-16 text-center">
        <p className="text-sm font-medium text-ink">Mission not found.</p>
        <Link href="/dashboard/missions" className="mt-2 inline-block text-sm text-ink underline hover:text-focus">
          Back to missions
        </Link>
      </div>
    );
  }

  const m = data.mission;
  const goal = m.goal;
  const goalLine =
    goal.metric && goal.targetValue !== undefined
      ? `${goal.metric}: target ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ""} in ${goal.timeframeDays ?? "?"} days (${goal.direction ?? "increase"})`
      : "No goal set";
  const steps = m.planSnapshot.steps ?? [];

  return (
    <div>
      <Link href="/dashboard/missions" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ChevronLeft size={14} /> Missions
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="aos-heading">{m.name}</h1>
            <MissionStatusBadge status={m.status} />
            <Chip>{m.businessTypeLabel}</Chip>
          </div>
          <p className="mt-1 text-sm text-muted">
            <span className="font-medium text-ink">Goal —</span> {goalLine}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-line">
              <div className="h-full rounded-full bg-ink" style={{ width: `${Math.round(data.progress * 100)}%` }} />
            </div>
            <span className="text-[11px] tabular-nums text-muted">
              {Math.round(data.progress * 100)}% · {data.stepCount}/{data.planStepCount} steps · {fmtCost(data.totalCostCents)} spent
            </span>
          </div>
          {data.nextCheckpoint && (
            <p className="mt-1 text-xs text-subtle">Next checkpoint: {data.nextCheckpoint}</p>
          )}
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowAutomation(true)}
            disabled={m.status === "complete" || m.status === "archived"}
            className={btnGhost}
            title="Trigger an Activepieces webhook flow and log it on this mission"
          >
            <Zap size={14} /> Automation
          </button>
          {m.status === "paused" ? (
            <button onClick={() => void pauseResume("resume")} disabled={busy !== null} className={btnRun}>
              {busy === "resume" ? <Loader2 size={14} className="aos-spin" /> : <Play size={14} />} Resume
            </button>
          ) : (
            <button
              onClick={() => void pauseResume("pause")}
              disabled={busy !== null || m.status === "complete" || m.status === "archived"}
              className={btnGhost}
            >
              {busy === "pause" ? <Loader2 size={14} className="aos-spin" /> : <Pause size={14} />} Pause
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3"><ErrorBox message={error} /></div>
      )}

      <div className="mb-4 flex gap-1 border-b border-line">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
              tab === id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink"
            }`}
          >
            <Icon size={15} />
            {label}
            {id === "approvals" && pendingCount > 0 && (
              <span className="inline-flex items-center gap-1 rounded-full bg-needs px-1.5 py-0.5 text-[10px] font-semibold text-ink">
                <Shape extra="aos-shape--needs" size="8px" />
                {pendingCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {tab === "timeline" && <TimelineTab events={data.events} />}
      {tab === "approvals" && <ApprovalsTab missionId={missionId} approvals={data.approvals} onDecided={load} />}
      {tab === "plan" && <PlanTab steps={steps} />}
      {tab === "tasks" && <TasksTab />}

      {showAutomation && (
        <AutomationModal
          missionId={missionId}
          onClose={() => setShowAutomation(false)}
          onTriggered={() => {
            setShowAutomation(false);
            void load();
          }}
        />
      )}

      {/* Phase 16 slice 2: CopilotKit shell wired to the AG-UI backend
          (/api/agents/chat). Shell only — no generative components yet.
          No mission project context here: thread project resolves lazily
          to the workspace's first project on first send. */}
      <MarketrAgentShell variant="sidebar" copilotThreadId={`marketr-mission-${missionId}`} />
    </div>
  );
}

// ── Run-automation modal (Phase 12, Worker 3) ───────────────────────────────
// Fires a published Activepieces webhook flow through the mission-scoped
// route (so the trigger lands in the mission event log), then offers a
// status poll. Honest about unconfigured engines and non-webhook flows.

interface ApFlow {
  id: string;
  displayName: string;
  status: string;
  published: boolean;
  triggerPiece: string | null;
  triggerName: string | null;
  triggerableViaWebhook: boolean;
}

interface ApRunStatus {
  id: string;
  flowId: string;
  status: string;
  terminal: boolean;
  succeeded: boolean;
  startTime: string | null;
  finishTime: string | null;
  failure: { stepName: string | null; errorMessage: string | null } | null;
}

function AutomationModal({
  missionId,
  onClose,
  onTriggered,
}: {
  missionId: string;
  onClose: () => void;
  onTriggered: () => void;
}) {
  const [flows, setFlows] = useState<ApFlow[] | null>(null);
  const [notConfigured, setNotConfigured] = useState<string | null>(null);
  const [flowId, setFlowId] = useState("");
  const [payloadText, setPayloadText] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ runId: string | null; note: string } | null>(null);
  const [runStatus, setRunStatus] = useState<ApRunStatus | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await api<{ configured: boolean; flows: ApFlow[]; error?: string }>(
          "/api/integrations/activepieces/flows?limit=100",
        );
        setFlows(r.flows);
        const first = r.flows.find((f) => f.triggerableViaWebhook);
        if (first) setFlowId(first.id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Load failed.";
        if (/not connected|503/i.test(msg)) setNotConfigured(msg);
        else setError(msg);
      }
    })();
  }, []);

  async function trigger() {
    if (!flowId) {
      setError("Pick a flow first.");
      return;
    }
    let payload: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(payloadText.trim() || "{}");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("must be an object");
      payload = parsed as Record<string, unknown>;
    } catch (e) {
      setError(`Payload must be a JSON object: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    setBusy(true);
    setError(null);
    setRunStatus(null);
    try {
      const r = await api<{ ok: boolean; runId: string | null; note?: string }>(
        `/api/missions/${missionId}/automations`,
        { method: "POST", body: JSON.stringify({ flowId, payload }) },
      );
      setResult({ runId: r.runId ?? null, note: r.note ?? "Flow accepted." });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Trigger failed.");
    } finally {
      setBusy(false);
    }
  }

  async function pollStatus() {
    if (!result?.runId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ run: ApRunStatus | null }>(
        `/api/integrations/activepieces/runs/${encodeURIComponent(result.runId)}`,
      );
      setRunStatus(r.run);
      if (r.run?.terminal) onTriggered();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status check failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-lg bg-paper shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="aos-subheading flex items-center gap-2">
            <Zap size={15} /> Run automation
          </h3>
          <button onClick={onClose} className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-ink">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-3 px-4 py-4">
          {notConfigured && (
            <div className="flex items-start gap-2 rounded-lg bg-needs-tint px-3 py-2 text-sm text-ink">
              <span className="aos-shape aos-shape--needs aos-shape--edged mt-0.5 shrink-0 [--aos-shape-size:12px]" aria-hidden />
              <span>
                {notConfigured} Connect the engine under{" "}
                <Link href="/dashboard/settings/providers" className="font-medium underline">
                  Settings → Providers
                </Link>
                .
              </span>
            </div>
          )}

          {error && <ErrorBox message={error} />}

          {flows === null && !notConfigured && (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Loader2 size={14} className="aos-spin" /> Loading flows…
            </p>
          )}

          {flows && (
            <>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-muted">Flow</span>
                <select
                  value={flowId}
                  onChange={(e) => setFlowId(e.target.value)}
                  className={`${inputCls} w-full`}
                >
                  <option value="">— pick a flow —</option>
                  {flows.map((f) => (
                    <option key={f.id} value={f.id} disabled={!f.triggerableViaWebhook}>
                      {f.displayName} {!f.published ? "(unpublished)" : ""}{" "}
                      {f.triggerableViaWebhook
                        ? ""
                        : `— ${f.triggerPiece ?? "non-webhook"} trigger can't be fired externally`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-muted">Payload (JSON object)</span>
                <textarea
                  value={payloadText}
                  onChange={(e) => setPayloadText(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  className={`${inputCls} w-full font-mono text-xs`}
                />
              </label>
            </>
          )}

          {result && (
            <div className="rounded-lg bg-canvas px-3 py-2 text-sm text-ink">
              <p className="font-medium">Flow accepted.</p>
              {result.runId ? (
                <p className="mt-1">
                  Run <span className="font-mono text-xs">{result.runId}</span>
                  {runStatus && (
                    <span className="ml-2">
                      {runStatus.terminal ? (
                        runStatus.succeeded ? (
                          <span className={`${badgeBase} bg-done text-white`}>
                            <Shape extra="aos-shape--done" /> {runStatus.status}
                          </span>
                        ) : (
                          <span className={`${badgeBase} bg-failed text-white`}>
                            <Shape extra="aos-shape--failed" /> {runStatus.status}
                          </span>
                        )
                      ) : (
                        <span className={`${badgeBase} bg-running text-white`}>
                          <Shape extra="aos-shape--running aos-is-live" /> {runStatus.status}
                        </span>
                      )}
                    </span>
                  )}
                </p>
              ) : (
                <p className="mt-1">{result.note}</p>
              )}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-line px-4 py-3">
          {result?.runId && (
            <button onClick={() => void pollStatus()} disabled={busy} className={btnGhost}>
              {busy ? <Loader2 size={14} className="aos-spin" /> : <History size={14} />} Check status
            </button>
          )}
          {!result && (
            <button onClick={() => void trigger()} disabled={busy || !flowId} className={btnRun}>
              {busy ? <Loader2 size={14} className="aos-spin" /> : <Zap size={14} />} Trigger flow
            </button>
          )}
          <button onClick={onClose} className={btnGhost}>
            {result ? "Close" : "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}
