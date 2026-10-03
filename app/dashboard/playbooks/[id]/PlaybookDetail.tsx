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
import { confirmAction, toastError } from "@/lib/ui/feedback";

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

// ── Atoms (Agentic OS) ───────────────────────────────────────────────────────

const inputCls =
  "h-control-sm rounded-md border-[1.5px] border-control bg-paper px-3 text-sm text-ink placeholder:text-subtle focus:border-focus focus:outline-none focus:ring-[3px] focus:ring-[var(--aos-focus-halo)] focus-visible:outline-none";

const btnPrimary =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-white aos-press hover:bg-night-hover disabled:opacity-40";
const btnGhost =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-outline aos-press hover:bg-hover-paper disabled:opacity-40";
const btnRun =
  "inline-flex h-control-sm items-center gap-1.5 rounded-full bg-running px-4 text-sm font-semibold text-white aos-press disabled:opacity-40";
const btnTiny =
  "inline-flex h-6 items-center gap-1 rounded-full bg-paper px-2.5 text-[11px] font-semibold text-ink shadow-control aos-press hover:bg-hover-paper disabled:opacity-40";

// Sources, lifecycle statuses, labels, and analytic deltas are categories —
// never agent states, so always a neutral chip.
function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-paper px-2 py-0.5 text-xs font-semibold text-muted shadow-control">
      {children}
    </span>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-failed bg-failed-tint px-3 py-2 text-sm text-failed-text">
      <span className="mt-1 size-2.5 shrink-0 rounded-[2px] bg-failed" aria-hidden />
      <span>{message}</span>
    </div>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4" onClick={onClose}>
      <div
        className={`relative max-h-[85vh] w-full ${wide ? "max-w-3xl" : "max-w-lg"} overflow-y-auto rounded-lg bg-paper p-5 shadow-overlay`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between">
          <h3 className="aos-subheading">{title}</h3>
          <button onClick={onClose} className="rounded-full p-1 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
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
    if (!await confirmAction(`${label} v${v.version}?${to === "production" ? "\n\nYou are recorded as the human approver." : ""}`)) return;
    setBusy(`t-${v.id}-${to}`);
    try {
      await post(`/api/playbooks/${playbookId}/versions/${v.id}/transition`, { to });
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Transition failed.");
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (v: VersionView) => {
    if (!await confirmAction(`Roll back the PRODUCTION pointer to v${v.version}? This moves the pointer only — no history is rewritten.`)) return;
    setBusy(`r-${v.id}`);
    try {
      await post(`/api/playbooks/${playbookId}/labels`, { label: "production", version: v.version });
      await load();
    } catch (e) {
      toastError(e instanceof Error ? e.message : "Rollback failed.");
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
      toastError(e instanceof Error ? e.message : "Run failed.");
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
      <div className="py-12 text-center text-sm text-subtle">
        <Loader2 size={18} className="mx-auto aos-spin" />
      </div>
    );
  }

  if (error || !playbook) {
    return (
      <div>
        <Link href="/dashboard/playbooks" className="mb-3 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
          <ArrowLeft size={14} /> Playbooks
        </Link>
        <ErrorBox message={error ?? "Playbook not found."} />
      </div>
    );
  }

  const prod = versions.find((v) => v.labels.includes("production"));

  return (
    <div>
      <Link href="/dashboard/playbooks" className="mb-2 inline-flex items-center gap-1 text-sm text-muted hover:text-ink">
        <ArrowLeft size={14} /> Playbooks
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="aos-heading">{playbook.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Chip>{playbook.source}</Chip>
            {prod ? (
              <Chip>production v{prod.version}</Chip>
            ) : (
              <Chip>no production version</Chip>
            )}
            <span className="text-xs text-muted">{versions.length} version{versions.length === 1 ? "" : "s"}</span>
          </div>
          {playbook.description && (
            <p className="mt-1.5 max-w-2xl text-sm text-muted">{playbook.description}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <button onClick={run} className={btnRun} disabled={running || !prod} title="Resolve the production label and draft the plan (propose-only)">
            {running ? <Loader2 size={14} className="aos-spin" /> : <Play size={14} />} Run draft plan
          </button>
          <button onClick={() => setNewVersionOpen(true)} className={btnPrimary}>
            <Plus size={14} /> New version
          </button>
        </div>
      </div>

      <div className="mt-4 border-b border-line">
        <div className="flex gap-1">
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium ${
                tab === id
                  ? "border-ink text-ink"
                  : "border-transparent text-muted hover:text-ink"
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
          <div className="mb-3 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
            Propose-only stub: this plan is drafted from the production playbook version. Nothing
            was executed, approved, or sent. Run logged as <span className="font-mono">{runResult.runLogId.slice(0, 8)}…</span>
          </div>
          <ol className="space-y-2">
            {runResult.plan.map((s) => (
              <li key={s.order} className="rounded-lg bg-paper px-3 py-2 shadow-hairline">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-canvas text-[11px] font-semibold text-ink">
                    {s.order}
                  </span>
                  <span className="text-sm font-medium text-ink">{s.title}</span>
                  {s.executor && <Chip>{s.executor}</Chip>}
                  <Chip>proposed</Chip>
                </div>
                {s.detail && <p className="mt-1 text-xs text-muted">{s.detail}</p>}
              </li>
            ))}
          </ol>
          <p className="mt-3 text-xs text-muted">{runResult.note}</p>
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
    <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            <th className="px-3 py-2 font-semibold">Version</th>
            <th className="px-3 py-2 font-semibold">Status</th>
            <th className="px-3 py-2 font-semibold">Labels</th>
            <th className="px-3 py-2 font-semibold">Hash</th>
            <th className="px-3 py-2 font-semibold">Created</th>
            <th className="px-3 py-2 font-semibold">Eval</th>
            <th className="px-3 py-2 font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const isProd = v.labels.includes("production");
            const steps = contentSteps(v.content);
            return (
              <Fragment key={v.id}>
                <tr className="border-b border-line last:border-0 hover:bg-hover-paper">
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onExpand(expanded === v.id ? null : v.id)}
                      className="flex items-center gap-1 font-medium text-ink hover:text-focus hover:underline"
                    >
                      <Eye size={13} className="text-subtle" /> v{v.version}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    <Chip>{v.status}</Chip>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {v.labels.map((l) => (
                        <Chip key={l}>{l}</Chip>
                      ))}
                      {v.labels.length === 0 && <span className="text-subtle">—</span>}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-muted" title={v.contentHash}>
                    {v.contentHash.slice(0, 8)}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    <div className="text-xs">{new Date(v.createdAt).toLocaleDateString()}</div>
                    <div className="font-mono text-[11px] text-subtle">{v.createdBy.slice(0, 12)}…</div>
                  </td>
                  <td className="px-3 py-2">
                    {v.eval ? (
                      <span className="text-xs text-muted">
                        {Object.entries(v.eval.metricDeltas)
                          .slice(0, 2)
                          .map(([k, d]) => (
                            <span key={k} className="mr-1">
                              <span className="font-semibold tabular-nums text-ink">
                                {d >= 0 ? "+" : ""}{d}%
                              </span>{" "}
                              {k}
                            </span>
                          ))}
                      </span>
                    ) : (
                      <span className="text-subtle">—</span>
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
                          {busy === `t-${v.id}-${to}` ? <Loader2 size={11} className="aos-spin" /> : null}
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
                  <tr className="border-b border-line bg-canvas">
                    <td colSpan={7} className="px-3 py-3">
                      <div className="text-xs font-semibold text-muted">
                        Steps ({steps.length})
                      </div>
                      <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-ink">
                        {steps.map((s, i) => (
                          <li key={i}>
                            <span className="font-medium">{s.title}</span>
                            {s.detail && <span className="text-muted"> — {s.detail}</span>}
                            {s.executor && <Chip>{s.executor}</Chip>}
                            {s.stepType === "automation" && (
                              <Chip>
                                <Zap size={10} className="inline" /> automation
                                {s.automation?.flowName ? `: ${s.automation.flowName}` : s.automation?.flowId ? `: ${s.automation.flowId}` : ""}
                              </Chip>
                            )}
                          </li>
                        ))}
                      </ol>
                      {v.outcomeAttribution && (
                        <div className="mt-2">
                          <div className="text-xs font-semibold text-muted">
                            Outcome attribution
                          </div>
                          <pre className="mt-1 max-h-40 overflow-auto rounded-lg bg-paper p-2 font-mono text-[11px] text-muted shadow-hairline">
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
              <td colSpan={7} className="px-3 py-8 text-center text-sm text-subtle">
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
      <div className="rounded-lg bg-paper px-3 py-8 text-center text-sm text-subtle shadow-hairline">
        No outcome evaluations recorded yet. Use “Record eval” on a version to log metric deltas
        with honest uncertainty bars.
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg bg-paper shadow-hairline">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-line text-xs font-semibold text-muted">
            <th className="px-3 py-2 font-semibold">Version</th>
            <th className="px-3 py-2 font-semibold">Metric deltas</th>
            <th className="px-3 py-2 font-semibold">Attribution (proven vs not)</th>
            <th className="px-3 py-2 font-semibold">Uncertainty</th>
          </tr>
        </thead>
        <tbody>
          {withEvals.map((v) => (
            <tr key={v.id} className="border-b border-line last:border-0 hover:bg-hover-paper">
              <td className="px-3 py-2">
                <Chip>v{v.version}</Chip>
              </td>
              <td className="px-3 py-2">
                <div className="flex flex-wrap gap-1">
                  {Object.entries(v.eval!.metricDeltas).map(([k, d]) => (
                    <Chip key={k}>
                      {d >= 0 ? "+" : ""}{d}% {k}
                    </Chip>
                  ))}
                </div>
              </td>
              <td className="max-w-md px-3 py-2 text-xs text-muted">{v.eval!.attributionNote}</td>
              <td className="px-3 py-2 text-xs text-muted">
                <div className="font-mono">
                  [{v.eval!.uncertainty.lowerBound} … {v.eval!.uncertainty.upperBound}]
                </div>
                <div className="text-subtle">{v.eval!.uncertainty.basis}</div>
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
      <div className="mb-3 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
        Be honest about uncertainty: record what the eval proves <b className="text-ink">and</b> what it does not prove.
        One metric per line, e.g. <span className="font-mono">bookedJobsLiftPct: 12</span>
      </div>
      {error && (
        <div className="mb-3"><ErrorBox message={error} /></div>
      )}
      <label className="mb-1 block text-xs font-semibold text-muted">Metric deltas (%)</label>
      <textarea value={deltas} onChange={(e) => setDeltas(e.target.value)} rows={3} placeholder="bookedJobsLiftPct: 12" className={`${inputCls} mb-3 w-full font-mono`} />
      <label className="mb-1 block text-xs font-semibold text-muted">Attribution note — proven vs not proven</label>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        rows={3}
        placeholder="Lift observed vs control in 2 weeks; NOT proven: seasonality not ruled out."
        className={`${inputCls} mb-3 w-full`}
      />
      <div className="mb-4 grid grid-cols-3 gap-2">
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted">Lower bound</label>
          <input value={lower} onChange={(e) => setLower(e.target.value)} placeholder="4" className={`${inputCls} w-full font-mono`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted">Upper bound</label>
          <input value={upper} onChange={(e) => setUpper(e.target.value)} placeholder="19" className={`${inputCls} w-full font-mono`} />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-muted">Basis</label>
          <input value={basis} onChange={(e) => setBasis(e.target.value)} placeholder="n=14, bootstrap 95% CI" className={`${inputCls} w-full`} />
        </div>
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost} disabled={saving}>
          Cancel
        </button>
        <button onClick={save} className={btnPrimary} disabled={saving}>
          {saving ? <Loader2 size={14} className="aos-spin" /> : <FlaskConical size={14} />} Record eval
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
      <div className="mb-3 rounded-lg bg-canvas px-3 py-2 text-xs text-muted">
        Versions are immutable — this creates v(n+1) with status <b className="text-ink">draft</b>. Nothing existing is
        changed.
      </div>
      {error && (
        <div className="mb-3"><ErrorBox message={error} /></div>
      )}
      <label className="mb-1 block text-xs font-semibold text-muted">Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Review sprint v2" className={`${inputCls} mb-3 w-full`} />
      <label className="mb-1 block text-xs font-semibold text-muted">Steps (one per line)</label>
      <textarea value={steps} onChange={(e) => setSteps(e.target.value)} rows={6} placeholder="Pull the GBP insights report&#10;Draft the review asks&#10;Schedule the Friday photo post" className={`${inputCls} mb-4 w-full`} />
      <div className="mb-4 rounded-lg bg-canvas px-3 py-3">
        <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-muted">
          <Zap size={12} className="text-ink" /> Automation step (optional) — fires an Activepieces webhook flow
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-muted">Flow ID</label>
            <input value={autoFlowId} onChange={(e) => setAutoFlowId(e.target.value)} placeholder="e.g. abc123…" className={`${inputCls} w-full font-mono`} />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-semibold text-muted">Flow name (label)</label>
            <input value={autoFlowName} onChange={(e) => setAutoFlowName(e.target.value)} placeholder="Weekly rank digest" className={`${inputCls} w-full`} />
          </div>
        </div>
        <label className="mb-1 mt-2 block text-[11px] font-semibold text-muted">Payload template (JSON object)</label>
        <textarea value={autoPayload} onChange={(e) => setAutoPayload(e.target.value)} rows={2} spellCheck={false} className={`${inputCls} w-full font-mono`} />
      </div>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className={btnGhost} disabled={saving}>
          Cancel
        </button>
        <button onClick={save} className={btnPrimary} disabled={saving}>
          {saving ? <Loader2 size={14} className="aos-spin" /> : <Plus size={14} />} Create version
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
        <ErrorBox message={error} />
      )}

      <div className="rounded-lg bg-paper p-4 shadow-hairline">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ink">Community sharing</div>
            <p className="mt-0.5 max-w-xl text-sm text-muted">
              Sharing is <b className="text-ink">off by default</b>. Turning it on allows anonymized exports of this
              workspace&apos;s playbooks — tenant data, business names, and metric absolutes are
              stripped before anything leaves the workspace.
            </p>
          </div>
          <button onClick={flipOptIn} disabled={busy || optIn === null} className={btnGhost}>
            {busy ? <Loader2 size={14} className="aos-spin" /> : null}
            {optIn ? "Turn sharing OFF" : "Opt in to sharing"}
          </button>
        </div>
        <div className="mt-2">
          <Chip>{optIn ? "sharing enabled" : "sharing disabled"}</Chip>
        </div>
      </div>

      <div className="rounded-lg bg-paper p-4 shadow-hairline">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-ink">Export this playbook</div>
            <p className="mt-0.5 max-w-xl text-sm text-muted">
              Exports the production version (latest version as fallback) as anonymized JSON.
              Quarantined automatically when tenant signal cannot be stripped confidently.
            </p>
          </div>
          <button onClick={doExport} disabled={busy} className={btnPrimary}>
            {busy ? <Loader2 size={14} className="aos-spin" /> : <Download size={14} />} Export anonymized JSON
          </button>
        </div>
        {exportJson && (
          <div className="mt-3">
            <pre className="max-h-72 overflow-auto rounded-lg bg-canvas p-3 font-mono text-[11px] text-muted">
              {exportJson}
            </pre>
            <button onClick={download} className={`${btnGhost} mt-2`}>
              <Download size={14} /> Download file
            </button>
          </div>
        )}
      </div>

      <div className="rounded-lg bg-paper p-4 shadow-hairline">
        <div className="text-sm font-semibold text-ink">Import a playbook</div>
        <p className="mt-0.5 max-w-xl text-sm text-muted">
          Paste a <span className="font-mono">marketr.playbook/v1</span> export. Imported playbooks
          start at v1 / <b className="text-ink">draft</b> and must travel the lifecycle before use.
        </p>
        <textarea
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={5}
          placeholder='{"format": "marketr.playbook/v1", …}'
          className={`${inputCls} mt-3 w-full font-mono text-xs`}
        />
        <button onClick={doImport} disabled={busy || !importText.trim()} className={`${btnPrimary} mt-2`}>
          {busy ? <Loader2 size={14} className="aos-spin" /> : <Upload size={14} />} Import playbook
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
