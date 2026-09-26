// Marketr — Mission detail client (Phase 9, M4).
// Header (goal, status, progress) + icon sub-tabs (Timeline | Approvals | Plan),
// dense event timeline, approval queue with Approve/Deny, pause/resume.
// House style: StudioApp.tsx class-by-class.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  History,
  ListChecks,
  Loader2,
  Pause,
  Play,
  ShieldCheck,
  X,
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

// ── Atoms (from StudioApp.tsx) ───────────────────────────────────────────────

function Chip({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "violet" | "green" | "amber" | "red" | "blue" }) {
  const tones: Record<string, string> = {
    slate: "bg-slate-100 text-slate-600 border-slate-200",
    violet: "bg-violet-50 text-violet-700 border-violet-200",
    green: "bg-emerald-50 text-emerald-700 border-emerald-200",
    amber: "bg-amber-50 text-amber-700 border-amber-200",
    red: "bg-red-50 text-red-700 border-red-200",
    blue: "bg-blue-50 text-blue-700 border-blue-200",
  };
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-tight ${tones[tone]}`}>
      {children}
    </span>
  );
}

function statusTone(status: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "active": return "violet";
    case "paused": return "amber";
    case "complete": return "green";
    case "archived": return "slate";
    default: return "slate";
  }
}

function approvalTone(status: string): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (status) {
    case "pending": return "amber";
    case "approved": return "green";
    case "denied": return "red";
    case "expired": return "slate";
    default: return "slate";
  }
}

const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";
const btnDangerGhost =
  "flex items-center gap-1.5 rounded-md border border-red-200 bg-white px-2.5 py-1.5 text-[13px] text-red-700 hover:bg-red-50 disabled:opacity-40";

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

function tierTone(tier: number): "slate" | "violet" | "amber" | "red" {
  switch (tier) {
    case 0: return "slate";
    case 1: return "violet";
    case 2: return "amber";
    default: return "red";
  }
}

function fmtCost(cents: number): string {
  return cents === 0 ? "—" : `$${(cents / 100).toFixed(2)}`;
}

// ── Sub-tab panels ───────────────────────────────────────────────────────────

function TimelineTab({ events }: { events: DetailEvent[] }) {
  if (events.length === 0) {
    return <p className="py-8 text-center text-[13px] text-stone-400">No events yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className="w-full min-w-[820px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-medium">Time</th>
            <th className="px-3 py-2 font-medium">Step</th>
            <th className="px-3 py-2 font-medium">Actor</th>
            <th className="px-3 py-2 font-medium">Tool</th>
            <th className="px-3 py-2 font-medium">Observation</th>
            <th className="px-3 py-2 text-right font-medium">Cost</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
              <td className="whitespace-nowrap px-3 py-2 text-[11.5px] tabular-nums text-stone-500">
                {new Date(e.ts).toLocaleString()}
              </td>
              <td className="px-3 py-2 font-mono text-[11.5px] text-stone-800">{e.step ?? "—"}</td>
              <td className="px-3 py-2 text-stone-600">{e.actor}</td>
              <td className="px-3 py-2 text-stone-600">{e.tool ?? "—"}</td>
              <td className="max-w-[380px] truncate px-3 py-2 text-stone-600" title={summarizeObservation(e.observation)}>
                {summarizeObservation(e.observation)}
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-stone-600">{fmtCost(e.costCents)}</td>
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
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div>
        <div className="mb-2 flex items-center gap-2">
          <span className="text-[12px] font-medium uppercase tracking-wide text-stone-500">Pending</span>
          <Chip tone={pending.length > 0 ? "amber" : "slate"}>{pending.length}</Chip>
        </div>
        {pending.length === 0 ? (
          <p className="rounded-lg border border-stone-200 bg-white px-3 py-6 text-center text-[13px] text-stone-400">
            No pending approvals — nothing is waiting on you.
          </p>
        ) : (
          <div className="space-y-2">
            {pending.map((a) => (
              <div key={a.id} className="rounded-lg border border-stone-200 bg-white px-3.5 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-[13.5px] font-semibold text-stone-900">{a.action}</span>
                  <Chip tone={tierTone(a.tier)}>Tier {a.tier}</Chip>
                  <span className="ml-auto text-[11.5px] text-stone-400">
                    expires {a.expiresAt ? new Date(a.expiresAt).toLocaleString() : "—"}
                  </span>
                </div>
                <div className="mt-1.5 max-w-full overflow-hidden text-ellipsis font-mono text-[11.5px] text-stone-500">
                  {JSON.stringify(a.bindingJson)}
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button onClick={() => void decide(a.id, "approved")} disabled={busyId !== null} className={btnPrimary}>
                    {busyId === a.id ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Approve
                  </button>
                  <button onClick={() => void decide(a.id, "denied")} disabled={busyId !== null} className={btnDangerGhost}>
                    {busyId === a.id ? <Loader2 size={14} className="animate-spin" /> : <X size={14} />} Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {decided.length > 0 && (
        <div>
          <div className="mb-2 text-[12px] font-medium uppercase tracking-wide text-stone-500">Decided</div>
          <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className="w-full min-w-[640px] text-left text-[13px]">
              <thead>
                <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
                  <th className="px-3 py-2 font-medium">Action</th>
                  <th className="px-3 py-2 font-medium">Tier</th>
                  <th className="px-3 py-2 font-medium">Decision</th>
                  <th className="px-3 py-2 font-medium">Decided by</th>
                  <th className="px-3 py-2 font-medium">Decided at</th>
                </tr>
              </thead>
              <tbody>
                {decided.map((a) => (
                  <tr key={a.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                    <td className="px-3 py-2 font-medium text-stone-900">{a.action}</td>
                    <td className="px-3 py-2"><Chip tone={tierTone(a.tier)}>Tier {a.tier}</Chip></td>
                    <td className="px-3 py-2"><Chip tone={approvalTone(a.status)}>{a.status}</Chip></td>
                    <td className="max-w-[180px] truncate px-3 py-2 text-stone-600" title={a.decidedBy ?? ""}>{a.decidedBy ?? "—"}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-[11.5px] tabular-nums text-stone-500">
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
    return <p className="py-8 text-center text-[13px] text-stone-400">No plan steps.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className="w-full min-w-[680px] text-left text-[13px]">
        <thead>
          <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-medium">#</th>
            <th className="px-3 py-2 font-medium">Step</th>
            <th className="px-3 py-2 font-medium">Executor</th>
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Tier</th>
            <th className="px-3 py-2 font-medium">Checkpoint</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s) => (
            <tr key={s.key} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
              <td className="px-3 py-2 tabular-nums text-stone-400">{s.order}</td>
              <td className="px-3 py-2">
                <div className="font-medium text-stone-900">{s.title}</div>
                <div className="text-[12px] text-stone-500">{s.description}</div>
              </td>
              <td className="px-3 py-2"><Chip>{s.executor}</Chip></td>
              <td className="px-3 py-2"><Chip tone="blue">{s.kind}</Chip></td>
              <td className="px-3 py-2"><Chip tone={tierTone(s.tier)}>Tier {s.tier}</Chip></td>
              <td className="px-3 py-2">
                {s.checkpointAfter ? <Check size={14} className="text-violet-600" /> : <span className="text-stone-300">—</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Detail shell ─────────────────────────────────────────────────────────────

const TABS = [
  { id: "timeline", label: "Timeline", icon: History },
  { id: "approvals", label: "Approvals", icon: ShieldCheck },
  { id: "plan", label: "Plan", icon: ListChecks },
] as const;

export function MissionDetail({ missionId }: { missionId: string }) {
  const [data, setData] = useState<MissionDetailData | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]["id"]>("timeline");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"pause" | "resume" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

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
      <div className="flex items-center gap-2 py-16 text-[13px] text-stone-500">
        <Loader2 size={16} className="animate-spin" /> Loading mission…
      </div>
    );
  }

  if (notFound || !data) {
    return (
      <div className="py-16 text-center">
        <p className="text-[14px] font-medium text-stone-900">Mission not found.</p>
        <Link href="/dashboard/missions" className="mt-2 inline-block text-[13px] text-violet-700 hover:underline">
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
      <Link href="/dashboard/missions" className="mb-2 inline-flex items-center gap-1 text-[13px] text-stone-500 hover:text-stone-800">
        <ChevronLeft size={14} /> Missions
      </Link>

      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold tracking-tight text-stone-900">{m.name}</h1>
            <Chip tone={statusTone(m.status)}>{m.status}</Chip>
            <Chip>{m.businessTypeLabel}</Chip>
          </div>
          <p className="mt-1 text-[13px] text-stone-500">
            <span className="font-medium text-stone-700">Goal —</span> {goalLine}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 w-40 overflow-hidden rounded-full bg-stone-200">
              <div className="h-full rounded-full bg-violet-600" style={{ width: `${Math.round(data.progress * 100)}%` }} />
            </div>
            <span className="text-[11px] tabular-nums text-stone-500">
              {Math.round(data.progress * 100)}% · {data.stepCount}/{data.planStepCount} steps · {fmtCost(data.totalCostCents)} spent
            </span>
          </div>
          {data.nextCheckpoint && (
            <p className="mt-1 text-[12px] text-stone-400">Next checkpoint: {data.nextCheckpoint}</p>
          )}
        </div>
        <div className="flex gap-2">
          {m.status === "paused" ? (
            <button onClick={() => void pauseResume("resume")} disabled={busy !== null} className={btnPrimary}>
              {busy === "resume" ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Resume
            </button>
          ) : (
            <button
              onClick={() => void pauseResume("pause")}
              disabled={busy !== null || m.status === "complete" || m.status === "archived"}
              className={btnGhost}
            >
              {busy === "pause" ? <Loader2 size={14} className="animate-spin" /> : <Pause size={14} />} Pause
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-3 flex items-start gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          <AlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <div className="mb-4 flex gap-1 border-b border-stone-200">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
              tab === id ? "border-violet-600 text-violet-700" : "border-transparent text-stone-500 hover:text-stone-800"
            }`}
          >
            <Icon size={15} />
            {label}
            {id === "approvals" && pendingCount > 0 && (
              <span className="rounded-full bg-amber-100 px-1.5 text-[10px] font-semibold text-amber-800">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {tab === "timeline" && <TimelineTab events={data.events} />}
      {tab === "approvals" && <ApprovalsTab missionId={missionId} approvals={data.approvals} onDecided={load} />}
      {tab === "plan" && <PlanTab steps={steps} />}
    </div>
  );
}
