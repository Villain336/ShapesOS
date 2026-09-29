// Marketr — Agent Playbook detail (Phase 9 M5, client).
// Header + icon sub-tabs: Versions | Evaluations | Sharing.
// Version history table with Promote / Rollback actions; eval recorder;
// sharing tab with opt-in, anonymized export preview, and import.

"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { MarketrAgentShell } from "@/components/agents/MarketrAgentShell";
import {
  ArrowLeft,
  BarChart3,
  Download,
  Eye,
  FlaskConical,
  GitBranch,
  Loader2,
  Play,
  Plus,
  RotateCcw,
  Share2,
  Upload,
  X,
  Zap,
} from "lucide-react";

type Status = "draft" | "eval" | "review" | "canary" | "production" | "deprecated";
type Label = "production" | "staging" | "latest";
type Source = "learned" | "community" | "seed";

interface StoredEval {
  metricDeltas: Record<string, number>;
  attributionNote: string;
  uncertainty: { lowerBound: number; upperBound: number; basis: string; confidence?: number };
  recordedBy: string;
  recordedAt: string;
}

interface VersionView {
  id: string;
  playbookId: string;
  version: number;
  status: Status;
  labels: Label[];
  contentHash: string;
  content: unknown;
  eval: StoredEval | null;
  outcomeAttribution: Record<string, unknown> | null;
  createdBy: string;
  createdAt: string;
}

interface Playbook {
  id: string;
  name: string;
  source: Source;
  description: string | null;
  createdAt: string;
}

interface DraftedStep {
  order: number;
  title: string;
  detail: string | null;
  executor: string | null;
  mode: "proposed";
}

const NEXT: Record<Status, Status[]> = {
  draft: ["eval"],
  eval: ["review"],
  review: ["canary", "deprecated"],
  canary: ["production", "deprecated"],
  production: ["deprecated"],
  deprecated: [],
};

const inputCls =
  "rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-900 placeholder:text-stone-400 focus:border-violet-400 focus:outline-none";
const btnPrimary =
  "flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-[13px] font-medium text-white hover:bg-violet-700 disabled:opacity-40";
const btnGhost =
  "flex items-center gap-1.5 rounded-md border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 hover:bg-stone-50 disabled:opacity-40";
const btnTiny =
  "inline-flex items-center gap-1 rounded-md border border-stone-200 bg-white px-2 py-0.5 text-[11px] font-medium text-stone-700 hover:bg-stone-50 disabled:opacity-40";

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

function statusTone(s: Status): "slate" | "violet" | "green" | "amber" | "red" | "blue" {
  switch (s) {
    case "draft": return "slate";
    case "eval": return "blue";
    case "review": return "amber";
    case "canary": return "violet";
    case "production": return "green";
    case "deprecated": return "red";
  }
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-stone-900/30" onClick={onClose} />
      <div className={`relative w-full ${wide ? "max-w-3xl" : "max-w-lg"} max-h-[85vh] overflow-y-auto rounded-lg border border-stone-200 bg-white p-5 shadow-xl`}>
        <div className="mb-4 flex items-start justify-between">
          <h3 className="text-[15px] font-semibold text-stone-900">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-stone-400 hover:bg-stone-100 hover:text-stone-700" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Phase 12, Worker 3: full step shape including the automation variant
// (lib/playbooks/store.ts PlaybookStep). Versions are immutable JSON
// snapshots; older versions simply omit these fields.
interface StepView {
  title: string;
  detail?: string;
  executor?: string;
  stepType?: "task" | "automation";
  automation?: {
    flowId?: string;
    flowName?: string;
    payloadTemplate?: Record<string, unknown>;
  };
}

function contentSteps(content: unknown): StepView[] {
  if (content && typeof content === "object" && Array.isArray((content as { steps?: unknown }).steps)) {
    return (content as { steps: StepView[] }).steps;
  }
  return [];
}

export function PlaybookDetail({ playbookId }: { playbookId: string }) {
  const [playbook, setPlaybook] = useState<Playbook | null>(null);
  const [versions, setVersions] = useState<VersionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"versions" | "evals" | "sharing">("versions");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [evalFor, setEvalFor] = useState<VersionView | null>(null);
  const [newVersionOpen, setNewVersionOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runResult, setRunResult] = useState<{ version: number; plan: DraftedStep[]; note: string; runLogId: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/playbooks/${playbookId}`, { cache: "no-store" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed to load playbook.");
      setPlaybook(j.playbook);
      setVersions(j.versions ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load playbook.");
    } finally {
      setLoading(false);
    }
  }, [playbookId]);

  useEffect(() => {
    load();
  }, [load]);

  const post = async (url: string, body: unknown) => {
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error ?? "Request failed.");
    return j;
  };

  const transition = async (v: VersionView, to: Status) => {
    const label = to === "deprecated" ? "deprecate" : `promote to ${to}`;
    if (!confirm(`${label} v${v.version}?${to === "production" ? "\n\nYou are recorded as the human approver." : ""}`)) return;
    setBusy(`t-${v.id}-${to}`);
    try {
      await post(`/api/playbooks/${playbookId}/versions/${v.id}/transition`, { to });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Transition failed.");
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (v: VersionView) => {
    if (!confirm(`Roll back the PRODUCTION pointer to v${v.version}? This moves the pointer only — no history is rewritten.`)) return;
    setBusy(`r-${v.id}`);
    try {
      await post(`/api/playbooks/${playbookId}/labels`, { label: "production", version: v.version });
      await load();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Rollback failed.");
    } finally {
      setBusy(null);
    }
  };

  const run = async () => {
    setRunning(true);
    try {
      const j = await post(`/api/playbooks/${playbookId}/run`, { input: { via: "playbooks-ui" } });
      setRunResult(j);
      setRunOpen(true);
    } catch (e) {
      alert(e instanceof Error ? e.message : "Run failed.");
    } finally {
      setRunning(false);
    }
  };

  const tabs = [
    { id: "versions" as const, label: "Versions", icon: GitBranch },
    { id: "evals" as const, label: "Evaluations", icon: BarChart3 },
    { id: "sharing" as const, label: "Sharing", icon: Share2 },
  ];

  if (loading) {
    return (
      <div className="py-12 text-center text-[13px] text-stone-400">
        <Loader2 size={18} className="mx-auto animate-spin" />
      </div>
    );
  }

  if (error || !playbook) {
    return (
      <div>
        <Link href="/dashboard/playbooks" className="mb-3 inline-flex items-center gap-1 text-[13px] text-stone-500 hover:text-violet-700">
          <ArrowLeft size={14} /> Playbooks
        </Link>
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error ?? "Playbook not found."}
        </div>
      </div>
    );
  }

  const prod = versions.find((v) => v.labels.includes("production"));

  return (
    <div>
      <Link href="/dashboard/playbooks" className="mb-2 inline-flex items-center gap-1 text-[13px] text-stone-500 hover:text-violet-700">
        <ArrowLeft size={14} /> Playbooks
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-stone-900">{playbook.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip tone={playbook.source === "learned" ? "violet" : playbook.source === "community" ? "blue" : "slate"}>
              {playbook.source}
            </Chip>
            {prod ? (
              <Chip tone="green">production v{prod.version}</Chip>
            ) : (
              <Chip tone="amber">no production version</Chip>
            )}
            <span className="text-[12px] text-stone-500">{versions.length} version{versions.length === 1 ? "" : "s"}</span>
          </div>
          {playbook.description && (
            <p className="mt-1.5 max-w-2xl text-[13px] text-stone-500">{playbook.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={run} className={btnGhost} disabled={running || !prod} title="Resolve the production label and draft the plan (propose-only)">
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />} Run draft plan
          </button>
          <button onClick={() => setNewVersionOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New version
          </button>
        </div>
      </div>

      <div className="mt-4 border-b border-stone-200">
        <div className="flex gap-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium transition ${
                tab === id
                  ? "border-violet-600 text-violet-700"
                  : "border-transparent text-stone-500 hover:text-stone-800"
              }`}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4">
        {tab === "versions" && (
          <VersionsTab
            versions={versions}
            busy={busy}
            expanded={expanded}
            onExpand={setExpanded}
            onTransition={transition}
            onRollback={rollback}
            onRecordEval={setEvalFor}
          />
        )}
        {tab === "evals" && <EvalsTab versions={versions} />}
        {tab === "sharing" && <SharingTab playbookId={playbookId} playbookName={playbook.name} />}
      </div>

      {evalFor && (
        <EvalModal
          version={evalFor}
          onClose={() => setEvalFor(null)}
          onDone={() => {
            setEvalFor(null);
            load();
          }}
          post={post}
        />
      )}
      {newVersionOpen && (
        <NewVersionModal
          onClose={() => setNewVersionOpen(false)}
          onDone={() => {
            setNewVersionOpen(false);
            load();
          }}
          post={post}
        />
      )}
      {runOpen && runResult && (
        <Modal title={`Drafted plan — production v${runResult.version}`} onClose={() => setRunOpen(false)} wide>
          <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
            Propose-only stub: this plan is drafted from the production playbook version. Nothing
            was executed, approved, or sent. Run logged as <span className="font-mono">{runResult.runLogId.slice(0, 8)}…</span>
          </div>
          <ol className="space-y-2">
            {runResult.plan.map((s) => (
              <li key={s.order} className="rounded-md border border-stone-200 bg-white px-3 py-2">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-violet-100 text-[11px] font-semibold text-violet-700">
                    {s.order}
                  </span>
                  <span className="text-[13px] font-medium text-stone-900">{s.title}</span>
                  {s.executor && <Chip>{s.executor}</Chip>}
                  <Chip tone="amber">proposed</Chip>
                </div>
                {s.detail && <p className="mt-1 text-[12px] text-stone-500">{s.detail}</p>}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[12px] text-stone-500">{runResult.note}</p>
        </Modal>
      )}
    </div>
  );
}

function VersionsTab({
  versions,
  busy,
  expanded,
  onExpand,
  onTransition,
  onRollback,
  onRecordEval,
}: {
  versions: VersionView[];
  busy: string | null;
  expanded: string | null;
  onExpand: (id: string | null) => void;
  onTransition: (v: VersionView, to: Status) => void;
  onRollback: (v: VersionView) => void;
  onRecordEval: (v: VersionView) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-medium">Version</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Labels</th>
            <th className="px-3 py-2 font-medium">Hash</th>
            <th className="px-3 py-2 font-medium">Created</th>
            <th className="px-3 py-2 font-medium">Eval</th>
            <th className="px-3 py-2 font-medium">Actions</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const isProd = v.labels.includes("production");
            const steps = contentSteps(v.content);
            return (
              <Fragment key={v.id}>
                <tr className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onExpand(expanded === v.id ? null : v.id)}
                      className="flex items-center gap-1 font-medium text-stone-900 hover:text-violet-700"
                    >
                      <Eye size={13} className="text-stone-400" /> v{v.version}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <Chip tone={statusTone(v.status)}>{v.status}</Chip>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {v.labels.map((l) => (
                        <Chip key={l} tone={l === "production" ? "green" : l === "staging" ? "blue" : "slate"}>
                          {l}
                        </Chip>
                      ))}
                      {v.labels.length === 0 && <span className="text-stone-400">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-stone-500" title={v.contentHash}>
                    {v.contentHash.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-stone-600">
                    <div className="text-[12px]">{new Date(v.createdAt).toLocaleDateString()}</div>
                    <div className="font-mono text-[11px] text-stone-400">{v.createdBy.slice(0, 12)}…</div>
                  </td>
                  <td className="px-3 py-2">
                    {v.eval ? (
                      <span className="text-[12px] text-stone-600">
                        {Object.entries(v.eval.metricDeltas)
                          .slice(0, 2)
                          .map(([k, d]) => (
                            <span key={k} className="mr-1">
                              <span className="font-medium text-emerald-700">
                                {d >= 0 ? "+" : ""}{d}%
                              </span>{" "}
                              {k}
                            </span>
                          ))}
                      </span>
                    ) : (
                      <span className="text-stone-400">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {NEXT[v.status].map((to) => (
                        <button
                          key={to}
                          onClick={() => onTransition(v, to)}
                          disabled={busy != null}
                          className={btnTiny}
                          title={to === "production" ? "Requires your recorded approval" : undefined}
                        >
                          {busy === `t-${v.id}-${to}` ? <Loader2 size={11} className="animate-spin" /> : null}
                          {to === "deprecated" ? "Deprecate" : `→ ${to}`}
                        </button>
                      ))}
                      {!isProd && v.status !== "deprecated" && (
                        <button onClick={() => onRollback(v)} disabled={busy != null} className={btnTiny} title="Move the production pointer here (rollback)">
                          <RotateCcw size={11} /> Set production
                        </button>
                      )}
                      <button onClick={() => onRecordEval(v)} disabled={busy != null} className={btnTiny}>
                        <FlaskConical size={11} /> Record eval
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded === v.id && (
                  <tr className="border-b border-stone-100 bg-stone-50/50">
                    <td colSpan={7} className="px-3 py-3">
                      <div className="text-[12px] font-medium uppercase tracking-wide text-stone-500">
                        Steps ({steps.length})
                      </div>
                      <ol className="mt-1 list-decimal space-y-1 pl-5 text-[13px] text-stone-700">
                        {steps.map((s, i) => (
                          <li key={i}>
                            <span className="font-medium">{s.title}</span>
                            {s.detail && <span className="text-stone-500"> — {s.detail}</span>}
                            {s.executor && <Chip>{s.executor}</Chip>}
                            {s.stepType === "automation" && (
                              <Chip tone="violet">
                                <Zap size={10} className="inline" /> automation
                                {s.automation?.flowName ? `: ${s.automation.flowName}` : s.automation?.flowId ? `: ${s.automation.flowId}` : ""}
                              </Chip>
                            )}
                          </li>
                        ))}
                      </ol>
                      {v.outcomeAttribution && (
                        <div className="mt-2">
                          <div className="text-[12px] font-medium uppercase tracking-wide text-stone-500">
                            Outcome attribution
                          </div>
                          <pre className="mt-1 max-h-40 overflow-auto rounded-md border border-stone-200 bg-white p-2 font-mono text-[11px] text-stone-600">
                            {JSON.stringify(v.outcomeAttribution, null, 2)}
                          </pre>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {versions.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-8 text-center text-[13px] text-stone-400">
                No versions yet — create the first with “New version”.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function EvalsTab({ versions }: { versions: VersionView[] }) {
  const withEvals = versions.filter((v) => v.eval);
  if (withEvals.length === 0) {
    return (
      <div className="rounded-md border border-stone-200 bg-stone-50 px-3 py-8 text-center text-[13px] text-stone-400">
        No outcome evaluations recorded yet. Use “Record eval” on a version to log metric deltas
        with honest uncertainty bars.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-stone-200 bg-white">
      <table className="w-full text-left text-[13px]">
        <thead>
          <tr className="border-b border-stone-100 bg-stone-50/60 text-[11px] uppercase tracking-wide text-stone-500">
            <th className="px-3 py-2 font-medium">Version</th>
            <th className="px-3 py-2 font-medium">Metric deltas</th>
            <th className="px-3 py-2 font-medium">Attribution (proven vs not)</th>
            <th className="px-3 py-2 font-medium">Uncertainty</th>
          </tr>
        </thead>
        <tbody>
          {withEvals.map((v) => (
            <tr key={v.id} className="border-b border-stone-100 last:border-0 hover:bg-violet-50/40">
              <td className="px-3 py-2">
                <Chip tone="violet">v{v.version}</Chip>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {Object.entries(v.eval!.metricDeltas).map(([k, d]) => (
                    <Chip key={k} tone={d >= 0 ? "green" : "red"}>
                      {d >= 0 ? "+" : ""}{d}% {k}
                    </Chip>
                  ))}
                </div>
              </td>
              <td className="max-w-md px-3 py-2 text-[12px] text-stone-600">{v.eval!.attributionNote}</td>
              <td className="px-3 py-2 text-[12px] text-stone-600">
                <div className="font-mono">
                  [{v.eval!.uncertainty.lowerBound} … {v.eval!.uncertainty.upperBound}]
                </div>
                <div className="text-stone-500">{v.eval!.uncertainty.basis}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EvalModal({
  version,
  onClose,
  onDone,
  post,
}: {
  version: VersionView;
  onClose: () => void;
  onDone: () => void;
  post: (url: string, body: unknown) => Promise<unknown>;
}) {
  const [deltas, setDeltas] = useState("");
  const [note, setNote] = useState("");
  const [lower, setLower] = useState("");
  const [upper, setUpper] = useState("");
  const [basis, setBasis] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const metricDeltas: Record<string, number> = {};
    for (const line of deltas.split("\n")) {
      const m = line.trim().match(/^([A-Za-z_][\w.]*)\s*[:=]\s*(-?\d+(?:\.\d+)?)$/);
      if (m) metricDeltas[m[1]] = Number(m[2]);
    }
    const lo = Number(lower);
    const hi = Number(upper);
    if (Number.isNaN(lo) || Number.isNaN(hi)) {
      setError("Uncertainty needs numeric lower and upper bounds.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await post(`/api/playbooks/${version.playbookId}/versions/${version.id}/eval`, {
        metricDeltas,
        attributionNote: note,
        uncertainty: { lowerBound: lo, upperBound: hi, basis },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={`Record outcome eval — v${version.version}`} onClose={onClose}>
      <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
        Be honest about uncertainty: record what the eval proves <b>and</b> what it does not prove.
        One metric per line, e.g. <span className="font-mono">bookedJobsLiftPct: 12</span>
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Metric deltas (%)</label>
      <textarea value={deltas} onChange={(e) => setDeltas(e.target.value)} rows={3} placeholder="bookedJobsLiftPct: 12" className={`${inputCls} mb-3 w-full font-mono`} />
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Attribution note — proven vs not proven</label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="Lift observed vs control in 2 weeks; NOT proven: seasonality not ruled out."
        className={`${inputCls} mb-3 w-full`}
      />
      <div className="mb-4 grid grid-cols-3 gap-2">
        <div>
          <label className="mb-1 block text-[12px] font-medium text-stone-600">Lower bound</label>
          <input value={lower} onChange={(e) => setLower(e.target.value)} placeholder="4" className={`${inputCls} w-full font-mono`} />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-stone-600">Upper bound</label>
          <input value={upper} onChange={(e) => setUpper(e.target.value)} placeholder="19" className={`${inputCls} w-full font-mono`} />
        </div>
        <div>
          <label className="mb-1 block text-[12px] font-medium text-stone-600">Basis</label>
          <input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="n=14, bootstrap 95% CI" className={`${inputCls} w-full`} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost} disabled={saving}>
          Cancel
        </button>
        <button onClick={save} className={btnPrimary} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <FlaskConical size={14} />} Record eval
        </button>
      </div>
    </Modal>
  );
}

function NewVersionModal({
  onClose,
  onDone,
  post,
}: {
  onClose: () => void;
  onDone: () => void;
  post: (url: string, body: unknown) => Promise<unknown>;
}) {
  const [title, setTitle] = useState("");
  const [steps, setSteps] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Phase 12, Worker 3: optional automation step (Activepieces webhook flow).
  const [autoFlowId, setAutoFlowId] = useState("");
  const [autoFlowName, setAutoFlowName] = useState("");
  const [autoPayload, setAutoPayload] = useState("{}");

  const save = async () => {
    if (!title.trim()) {
      setError("Title is required.");
      return;
    }
    const stepList: StepView[] = steps
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => ({ title: s }));
    if (autoFlowId.trim()) {
      let payloadTemplate: Record<string, unknown> | undefined;
      try {
        const parsed: unknown = JSON.parse(autoPayload.trim() || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("payload template must be a JSON object");
        }
        payloadTemplate = parsed as Record<string, unknown>;
      } catch (e) {
        setError(`Payload template must be valid JSON: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      stepList.push({
        title: autoFlowName.trim() ? `Run automation: ${autoFlowName.trim()}` : `Run automation flow ${autoFlowId.trim()}`,
        stepType: "automation",
        executor: "scheduler",
        automation: {
          flowId: autoFlowId.trim(),
          flowName: autoFlowName.trim() || undefined,
          payloadTemplate,
        },
      });
    }
    if (stepList.length === 0) {
      setError("At least one step is required (one per line), or add an automation step.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await post(window.location.pathname.replace("/dashboard", "/api") + "/versions", {
        content: { title: title.trim(), steps: stepList },
      });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New playbook version" onClose={onClose}>
      <div className="mb-3 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-[12px] text-stone-500">
        Versions are immutable — this creates v(n+1) with status <b>draft</b>. Nothing existing is
        changed.
      </div>
      {error && (
        <div className="mb-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Review sprint v2" className={`${inputCls} mb-3 w-full`} />
      <label className="mb-1 block text-[12px] font-medium text-stone-600">Steps (one per line)</label>
      <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={6} placeholder="Pull the GBP insights report&#10;Draft the review asks&#10;Schedule the Friday photo post" className={`${inputCls} mb-4 w-full`} />
      <div className="mb-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-stone-600">
          <Zap size={12} className="text-violet-600" /> Automation step (optional) — fires an Activepieces webhook flow
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-stone-500">Flow ID</label>
            <input value={autoFlowId} onChange={(e) => setAutoFlowId(e.target.value)} placeholder="e.g. abc123…" className={`${inputCls} w-full font-mono`} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-stone-500">Flow name (label)</label>
            <input value={autoFlowName} onChange={(e) => setAutoFlowName(e.target.value)} placeholder="Weekly rank digest" className={`${inputCls} w-full`} />
          </div>
        </div>
        <label className="mb-1 mt-2 block text-[11px] font-medium text-stone-500">Payload template (JSON object)</label>
        <textarea value={autoPayload} onChange={(e) => setAutoPayload(e.target.value)} rows={2} spellCheck={false} className={`${inputCls} w-full font-mono`} />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost} disabled={saving}>
          Cancel
        </button>
        <button onClick={save} className={btnPrimary} disabled={saving}>
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Create version
        </button>
      </div>
    </Modal>
  );
}

function SharingTab({ playbookId, playbookName }: { playbookId: string; playbookName: string }) {
  const [optIn, setOptIn] = useState<boolean | null>(null);
  const [exportJson, setExportJson] = useState<string | null>(null);
  const [importText, setImportText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOptIn = useCallback(async () => {
    try {
      const r = await fetch("/api/playbooks/sharing-opt-in", { cache: "no-store" });
      const j = await r.json();
      setOptIn(j.enabled === true);
    } catch {
      setOptIn(false);
    }
  }, []);

  useEffect(() => {
    loadOptIn();
  }, [loadOptIn]);

  const flipOptIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await fetch("/api/playbooks/sharing-opt-in", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: !optIn }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Failed.");
      setOptIn(j.enabled === true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed.");
    } finally {
      setBusy(false);
    }
  };

  const doExport = async () => {
    setBusy(true);
    setError(null);
    setExportJson(null);
    try {
      const r = await fetch(`/api/playbooks/${playbookId}/export`, { method: "POST" });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Export failed.");
      setExportJson(JSON.stringify(j.export, null, 2));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Export failed.");
    } finally {
      setBusy(false);
    }
  };

  const download = () => {
    if (!exportJson) return;
    const blob = new Blob([exportJson], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${playbookName.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}.playbook.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const doImport = async () => {
    setBusy(true);
    setError(null);
    try {
      let envelope: unknown;
      try {
        envelope = JSON.parse(importText);
      } catch {
        throw new Error("Import text is not valid JSON.");
      }
      const r = await fetch("/api/playbooks/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelope }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? "Import failed.");
      window.location.href = `/dashboard/playbooks/${j.playbookId}`;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">
          {error}
        </div>
      )}

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold text-stone-900">Community sharing</div>
            <p className="mt-0.5 max-w-xl text-[13px] text-stone-500">
              Sharing is <b>off by default</b>. Turning it on allows anonymized exports of this
              workspace&apos;s playbooks — tenant data, business names, and metric absolutes are
              stripped before anything leaves the workspace.
            </p>
          </div>
          <button onClick={flipOptIn} disabled={busy || optIn === null} className={btnGhost}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : null}
            {optIn ? "Turn sharing OFF" : "Opt in to sharing"}
          </button>
        </div>
        <div className="mt-2">
          <Chip tone={optIn ? "green" : "slate"}>{optIn ? "sharing enabled" : "sharing disabled"}</Chip>
        </div>
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-[14px] font-semibold text-stone-900">Export this playbook</div>
            <p className="mt-0.5 max-w-xl text-[13px] text-stone-500">
              Exports the production version (latest version as fallback) as anonymized JSON.
              Quarantined automatically when tenant signal cannot be stripped confidently.
            </p>
          </div>
          <button onClick={doExport} disabled={busy} className={btnPrimary}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />} Export anonymized JSON
          </button>
        </div>
        {exportJson && (
          <div className="mt-3">
            <pre className="max-h-72 overflow-auto rounded-md border border-stone-200 bg-stone-50 p-3 font-mono text-[11px] text-stone-600">
              {exportJson}
            </pre>
            <button onClick={download} className={`${btnGhost} mt-2`}>
              <Download size={14} /> Download file
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <div className="text-[14px] font-semibold text-stone-900">Import a playbook</div>
        <p className="mt-0.5 max-w-xl text-[13px] text-stone-500">
          Paste a <span className="font-mono">marketr.playbook/v1</span> export. Imported playbooks
          start at v1 / <b>draft</b> and must travel the lifecycle before use.
        </p>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={5}
          placeholder='{"format": "marketr.playbook/v1", …}'
          className={`${inputCls} mt-3 w-full font-mono text-[12px]`}
        />
        <button onClick={doImport} disabled={busy || !importText.trim()} className={`${btnPrimary} mt-2`}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Import playbook
        </button>
      </div>

      {/* Phase 16 slice 2: CopilotKit shell wired to the AG-UI backend
          (/api/agents/chat). Shell only — no generative components yet.
          No playbook project context here: thread project resolves lazily
          to the workspace's first project on first send. */}
      <MarketrAgentShell variant="sidebar" copilotThreadId={`marketr-playbook-${playbookId}`} />
    </div>
  );
}
