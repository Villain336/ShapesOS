// Marketr — Mission detail client (Phase 9, M4; Agentic OS 4d).
//
// Kit layout (agent-blocks.png): the mission timeline as a run timeline
// (each delegation the lead made, then the plan steps still to come, with
// asks-first chips), next to the lead agent with the sub-agents it
// delegated to (AgentTree) and the approvals waiting on you as approval
// cards. Below: the full event log, decided approvals, the plan and Plane
// tasks. Pause / resume and approve / deny call the same mission APIs as
// before (editor+, re-checked server-side).

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { MarketrAgentShell } from "@/components/agents/MarketrAgentShell";
import {
  ArrowLeft,
  Check,
  ExternalLink,
  History,
  KanbanSquare,
  ListChecks,
  Loader2,
  ShieldCheck,
  X,
  Zap,
} from "lucide-react";
import { closeOnEscape } from "@/lib/ui/keyboard";
import { toast, toastError } from "@/lib/ui/feedback";
import { PlanAlternatives } from "./PlanAlternatives";
import { AgentTree, ApprovalCard, Banner, NeutralBadge, RunTimeline, StatusBadge, aosButton } from "@/components/aos";
import { needsReconnect } from "@/lib/aos/home";
import type { MissionView } from "@/lib/aos/agents";
import { approvalQuestion, approveLabelFor, missionAgentIndex } from "@/lib/aos/approvals";
import { missionLeadNode } from "@/lib/aos/missions";
import { clockTime, missionTimeline, type PlanStepInput } from "@/lib/aos/runs";
import { factLines, humanize } from "@/lib/approvals/format";
import { cn } from "@/lib/utils";
import { costSummary, formatCents } from "@/lib/missions/display";

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

function ErrorBox({ message }: { message: string }) {
  return (
    <p role="alert" className="flex items-start gap-2 text-md text-failed-text">
      <span className="mt-1.5 size-2.5 shrink-0 bg-failed" aria-hidden />
      <span>{message}</span>
    </p>
  );
}

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnGhost = aosButton({ variant: "secondary", size: "sm" });
const btnRun = aosButton({ variant: "run", size: "sm" });

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
    createdAt: string | null;
  };
  events: DetailEvent[];
  approvals: DetailApproval[];
  stepCount: number;
  /** Steps of the plan that are done; not the number of events or runs. */
  completedSteps: number;
  planStepCount: number;
  totalCostCents: number;
  /** Part of totalCostCents that is the cost model's estimate, not metered or billed. */
  estimatedCostCents: number;
  /** Fingerprint of the drafted plan this page loaded; sent back with the plan approval. */
  planRevision: string;
  progress: number;
  termination: { done: boolean; reason: string | null };
  nextCheckpoint: string | null;
  /** Agent state + the lead's delegations (null = archived). */
  agent: MissionView | null;
  runs: Array<{ id: string; kind: string; status: string; createdAt: string; endedAt: string | null }>;
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
  return formatCents(cents);
}

// ── Sub-tab panels ───────────────────────────────────────────────────────────

function EventLogTab({ events }: { events: DetailEvent[] }) {
  if (events.length === 0) {
    return <p className="py-8 text-center text-md text-muted">No events yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            <th className="px-4 py-2.5 font-semibold">Time</th>
            <th className="px-4 py-2.5 font-semibold">Step</th>
            <th className="px-4 py-2.5 font-semibold">Actor</th>
            <th className="px-4 py-2.5 font-semibold">Tool</th>
            <th className="px-4 py-2.5 font-semibold">Observation</th>
            <th className="px-4 py-2.5 text-right font-semibold">Cost</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted tabular-nums">{new Date(e.ts).toLocaleString()}</td>
              <td className="aos-mono px-4 py-2.5 text-xs text-ink">{e.step ?? "—"}</td>
              <td className="px-4 py-2.5 text-muted">{e.actor}</td>
              <td className="aos-mono px-4 py-2.5 text-xs text-muted">{e.tool ?? "—"}</td>
              <td className="max-w-[380px] truncate px-4 py-2.5 text-muted" title={summarizeObservation(e.observation)}>
                {summarizeObservation(e.observation)}
              </td>
              <td className="px-4 py-2.5 text-right text-muted tabular-nums">{fmtCost(e.costCents)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DecidedTab({ approvals }: { approvals: DetailApproval[] }) {
  if (approvals.length === 0) {
    return <p className="py-8 text-center text-md text-muted">No decisions yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            <th className="px-4 py-2.5 font-semibold">Action</th>
            <th className="px-4 py-2.5 font-semibold">Tier</th>
            <th className="px-4 py-2.5 font-semibold">Decision</th>
            <th className="px-4 py-2.5 font-semibold">Decided by</th>
            <th className="px-4 py-2.5 font-semibold">Decided at</th>
          </tr>
        </thead>
        <tbody>
          {approvals.map((a) => (
            <tr key={a.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="px-4 py-2.5 font-semibold text-ink">{humanize(a.action)}</td>
              <td className="px-4 py-2.5">
                <Chip>Tier {a.tier}</Chip>
              </td>
              <td className="px-4 py-2.5">
                {/* Approved work moves on (done); a denial or expiry is a decision, not an agent state. */}
                {a.status === "approved" ? (
                  <StatusBadge status="done" label="Approved" size="sm" />
                ) : (
                  <span className="inline-flex h-6 items-center rounded-full bg-paper px-2.5 text-xs font-semibold text-muted shadow-control">
                    {a.status === "denied" ? "Denied" : "Expired"}
                  </span>
                )}
              </td>
              <td className="max-w-[180px] truncate px-4 py-2.5 text-muted" title={a.decidedBy ?? ""}>
                {a.decidedBy ?? "—"}
              </td>
              <td className="px-4 py-2.5 text-xs whitespace-nowrap text-muted tabular-nums">
                {a.decidedAt ? new Date(a.decidedAt).toLocaleString() : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlanTab({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) {
    return <p className="py-8 text-center text-md text-muted">No plan steps.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg bg-paper shadow-hairline">
      <table className="w-full min-w-[680px] text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            <th className="px-4 py-2.5 font-semibold">#</th>
            <th className="px-4 py-2.5 font-semibold">Step</th>
            <th className="px-4 py-2.5 font-semibold">Executor</th>
            <th className="px-4 py-2.5 font-semibold">Kind</th>
            <th className="px-4 py-2.5 font-semibold">Tier</th>
            <th className="px-4 py-2.5 font-semibold">Checkpoint</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.key} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="px-4 py-2.5 text-subtle tabular-nums">{s.order}</td>
              <td className="px-4 py-2.5">
                <div className="font-semibold text-ink">{s.title}</div>
                <div className="text-xs text-muted">{s.description}</div>
              </td>
              <td className="px-4 py-2.5"><Chip>{s.executor}</Chip></td>
              <td className="px-4 py-2.5"><Chip>{s.kind}</Chip></td>
              <td className="px-4 py-2.5"><Chip>Tier {s.tier}</Chip></td>
              <td className="px-4 py-2.5">
                {s.checkpointAfter ? <Check size={14} className="text-ink" aria-label="Checkpoint after this step" /> : <span className="text-subtle">—</span>}
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
      <p className="mt-2 text-[0.6875rem] leading-snug text-subtle">
        Live from your Plane sidecar — tasks are managed in Plane; this tab is a
        read-only window into the selected project.
      </p>
    </div>
  );
}

// ── Detail shell ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "log", label: "Event log", icon: History },
  { id: "decided", label: "Decisions", icon: ShieldCheck },
  { id: "plan", label: "Plan", icon: ListChecks },
  { id: "tasks", label: "Tasks", icon: KanbanSquare },
] as const;

function planInputs(steps: PlanStep[]): PlanStepInput[] {
  return steps.map((s) => ({ key: s.key, title: s.title, kind: s.kind, executor: s.executor, tier: s.tier }));
}

export function MissionDetail({ missionId }: { missionId: string }) {
  const [data, setData] = useState<MissionDetailData | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("log");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"pause" | "resume" | null>(null);
  const [planBusy, setPlanBusy] = useState(false);
  const [deciding, setDeciding] = useState<{ id: string; which: "approve" | "deny" } | null>(null);
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
    try {
      const r = await api<{ ok: boolean; staleness?: { fresh: boolean; checks: Array<{ name: string; ok: boolean; detail?: string }> } }>(
        `/api/missions/${missionId}/${action}`,
        { method: "POST" },
      );
      if (action === "resume" && r.staleness && !r.staleness.fresh) {
        toastError("Still paused", "Stale data: the mission stays paused until a person reviews it.");
      } else {
        toast({ title: action === "pause" ? "Paused" : "Resumed", status: action === "pause" ? "done" : "running" });
      }
      await load();
    } catch (e) {
      toastError(action === "pause" ? "Couldn't pause" : "Couldn't resume", e instanceof Error ? e.message : undefined);
    } finally {
      setBusy(null);
    }
  }

  async function approvePlan() {
    if (!data) return;
    setPlanBusy(true);
    try {
      const r = await api<{ ok: boolean; status: string; launchError?: string }>(`/api/missions/${missionId}/approve-plan`, {
        method: "POST",
        body: JSON.stringify({ planRevision: data.planRevision }),
      });
      if (r.launchError) toastError("Plan approved, but the start could not be queued", r.launchError);
      else toast({ title: "Plan approved", description: "The mission is starting.", status: "running" });
      await load();
    } catch (e) {
      toastError("Couldn't approve the plan", e instanceof Error ? e.message : undefined);
    } finally {
      setPlanBusy(false);
    }
  }

  async function decide(a: DetailApproval, which: "approve" | "deny") {
    setDeciding({ id: a.id, which });
    try {
      await api(`/api/missions/${missionId}/approvals/${a.id}/decide`, {
        method: "POST",
        body: JSON.stringify({ decision: which === "approve" ? "approved" : "denied" }),
      });
      const label = approveLabelFor({ source: "mission", title: humanize(a.action), typeLabel: "Mission" });
      toast(
        which === "approve"
          ? { title: label === "Approve and send" ? "Approved and sent" : label === "Approve and publish" ? "Approved and published" : "Approved", description: humanize(a.action), status: "done" }
          : { title: "Denied", description: `${humanize(a.action)}. Nothing goes out.`, status: "done" },
      );
      await load();
    } catch (e) {
      toastError(which === "approve" ? "Couldn't approve" : "Couldn't deny", e instanceof Error ? e.message : "Decision failed.");
    } finally {
      setDeciding(null);
    }
  }

  const pending = useMemo(() => (data?.approvals ?? []).filter((a) => a.status === "pending"), [data]);
  const decided = useMemo(() => (data?.approvals ?? []).filter((a) => a.status !== "pending"), [data]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-16 text-md text-muted">
        <Loader2 size={16} className="aos-spin" aria-hidden /> Loading mission…
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <p className="aos-subheading">Mission not found</p>
        {error ? <ErrorBox message={error} /> : null}
        <Link href="/dashboard/missions" className={aosButton({ variant: "secondary", size: "sm" })}>
          Back to missions
        </Link>
      </div>
    );
  }

  const m = data.mission;
  const v = data.agent;
  const goal = m.goal;
  const goalLine =
    goal.metric && goal.targetValue !== undefined
      ? `${goal.metric}: target ${goal.targetValue}${goal.unit ? ` ${goal.unit}` : ""} in ${goal.timeframeDays ?? "?"} days (${goal.direction ?? "increase"})`
      : "No goal set";
  const steps = m.planSnapshot.steps ?? [];
  const timeline = v
    ? missionTimeline({
        events: data.events.map((e) => ({ ts: e.ts, actor: e.actor, step: e.step, args: e.args, observation: e.observation })),
        plan: planInputs(steps),
        status: v.status,
      })
    : null;
  const waitingAgent = v ? (missionAgentIndex([v])[v.id]?.agent ?? "Strategist") : "Strategist";
  const latestRun = data.runs[0] ?? null;
  const startedAt = m.createdAt ? new Date(m.createdAt) : null;

  return (
    <div className="flex flex-col gap-6">
      <Link href="/dashboard/missions" className={aosButton({ variant: "quiet", size: "sm", className: "-ml-3 self-start" })}>
        <ArrowLeft className="size-4" aria-hidden />
        Missions
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="aos-heading">{m.name}</h1>
            {v ? <StatusBadge status={v.status} /> : <NeutralBadge label="Archived" />}
          </div>
          <p className="mt-1.5 text-md text-muted">
            <span className="font-semibold text-ink">{m.businessTypeLabel}</span> · {goalLine}
          </p>
          <p className="mt-1 text-sm text-muted tabular-nums">
            {Math.round(data.progress * 100)}% of plan · {data.completedSteps}/{data.planStepCount} steps
            {costSummary(data.totalCostCents, data.estimatedCostCents)}
            {data.nextCheckpoint ? ` · Next checkpoint: ${data.nextCheckpoint}` : ""}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => setShowAutomation(true)}
            disabled={m.status === "complete" || m.status === "archived"}
            className={btnGhost}
            title="Trigger an Activepieces webhook flow and log it on this mission"
          >
            <Zap size={15} aria-hidden /> Automation
          </button>
          {latestRun ? (
            <Link href={`/dashboard/runs/${latestRun.id}`} className={btnGhost}>
              Open latest run
            </Link>
          ) : null}
        </div>
      </div>

      {error ? <ErrorBox message={error} /> : null}

      {m.status === "planned" ? (
        <Banner
          status="needs"
          title="Review the plan before anything runs"
          description={`The Strategist drafted ${steps.length} steps (the Plan tab below). Nothing runs until you approve the whole plan - and money, sends and publishing still ask again at their own step.`}
          action={{ label: planBusy ? "Approving..." : "Approve plan and start", onClick: () => void approvePlan() }}
        />
      ) : null}

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        {/* Mission timeline: the lead's delegations, then what is still to come. */}
        <div className="order-2 min-w-0 lg:order-1">
          {timeline && v ? (
            <RunTimeline
              title="Mission timeline"
              subtitle={startedAt && m.status === "planned" ? `Strategist drafted this plan at ${clockTime(startedAt)} on ${startedAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}. Not started yet.` : startedAt ? `Strategist started this mission at ${clockTime(startedAt)} on ${startedAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : "Strategist leads this mission"}
              status={v.status}
              steps={timeline.steps}
              completed={timeline.completed}
              busy={busy !== null}
              pauseLabel="Pause mission"
              resumeLabel="Resume mission"
              onPause={m.status === "active" ? () => void pauseResume("pause") : undefined}
              onResume={m.status === "paused" ? () => void pauseResume("resume") : undefined}
              headingLevel="h2"
              emptyText="The lead hasn't handed anything off yet."
            />
          ) : (
            <div className="rounded-lg bg-paper p-5 text-md text-muted shadow-hairline">
              This mission is archived. Its event log, decisions and plan are below.
            </div>
          )}
        </div>

        <div className="order-1 flex min-w-0 flex-col gap-5 lg:order-2">
          {v && v.status === "failed" ? (
            <Banner
              status="failed"
              title={`${v.branches.find((b) => b.status === "failed")?.name ?? "Strategist"} stopped`}
              description={needsReconnect(v.line) ? `${v.line}. Reconnect to resume.` : `${v.line}.`}
              action={
                needsReconnect(v.line)
                  ? { label: "Reconnect", href: "/dashboard/settings/connectors" }
                  : latestRun
                    ? { label: "Open run", href: `/dashboard/runs/${latestRun.id}` }
                    : null
              }
            />
          ) : null}
          {/* The lead and the sub-agents it delegated to. */}
          {v ? (
            <section aria-labelledby="team-h" className="rounded-lg bg-paper p-3 shadow-hairline sm:p-4">
              <h2 id="team-h" className="px-2.5 pt-1 pb-2 text-sm font-semibold text-muted">
                Who&apos;s on it
              </h2>
              <AgentTree lead={missionLeadNode(v)} branches={v.branches} />
              {v.branches.length === 0 ? (
                <p className="px-2.5 pt-1 pb-2 text-sm text-muted">Sub-agents appear here as the lead hands them steps.</p>
              ) : null}
            </section>
          ) : null}

          {/* Approvals waiting on you. */}
          <section id="approvals" aria-labelledby="approvals-h" className="flex scroll-mt-20 flex-col gap-3">
            <h2 id="approvals-h" className="aos-subheading">
              {pending.length ? `Waiting on you (${pending.length})` : "Approvals"}
            </h2>
            {pending.length === 0 ? (
              <p className="rounded-lg bg-paper px-4 py-5 text-md text-muted shadow-hairline">Nothing from this mission is waiting on you.</p>
            ) : (
              pending.map((a) => {
                const title = humanize(a.action);
                const facts = factLines(a.bindingJson);
                return (
                  <ApprovalCard
                    key={a.id}
                    agent={waitingAgent}
                    title={approvalQuestion({ source: "mission", title })}
                    meta={
                      <span>
                        Tier {a.tier}
                        {a.expiresAt ? ` · expires ${new Date(a.expiresAt).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                      </span>
                    }
                    body={`${waitingAgent} paused ${m.name} for your approval. Nothing goes out until you decide.`}
                    items={facts.lines.map((l, i) => ({ key: `${i}:${l.label}`, label: l.label, detail: l.detail ?? undefined }))}
                    approveLabel={approveLabelFor({ source: "mission", title, typeLabel: "Mission" })}
                    busy={deciding?.id === a.id ? deciding.which : null}
                    onApprove={() => void decide(a, "approve")}
                    onDeny={() => void decide(a, "deny")}
                  />
                );
              })
            )}
          </section>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        <div className="-mx-1 flex gap-1 overflow-x-auto border-b border-line px-1" role="tablist" aria-label="Mission records">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => setTab(id)}
              className={cn(
                "-mb-px flex shrink-0 items-center gap-1.5 border-b-2 px-3 py-2.5 text-md font-semibold whitespace-nowrap",
                tab === id ? "border-ink text-ink" : "border-transparent text-muted hover:text-ink",
              )}
            >
              <Icon size={15} aria-hidden />
              {label}
              {id === "decided" && decided.length > 0 ? <span className="text-muted tabular-nums">{decided.length}</span> : null}
            </button>
          ))}
        </div>

        {tab === "log" && <EventLogTab events={data.events} />}
        {tab === "decided" && <DecidedTab approvals={decided} />}
        {tab === "plan" && (
          <>
            <PlanAlternatives missionId={missionId} status={m.status} onChanged={load} />
            <PlanTab steps={steps} />
          </>
        )}
        {tab === "tasks" && <TasksTab />}
      </div>

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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-night/30 p-4" role="presentation" onClick={onClose} onKeyDown={closeOnEscape(onClose)}>
      <div
        className="w-full max-w-lg rounded-lg bg-paper shadow-overlay"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h3 className="aos-subheading flex items-center gap-2">
            <Zap size={15} /> Run automation
          </h3>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-ink">
            <X size={15} aria-hidden />
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
                      <StatusBadge
                        status={runStatus.terminal ? (runStatus.succeeded ? "done" : "failed") : "running"}
                        label={runStatus.status}
                        size="sm"
                      />
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
