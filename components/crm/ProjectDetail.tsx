// Marketr CRM — project detail slide-over (Phase 17 slice 4).
// Milestones (add / complete / reopen), time ledger (log hours, mark
// billed), totals, and the complete-project action with its unbilled-time
// nudge (info only — never a gate).

"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Clock3, Loader2, Plus, RotateCcw, X } from "lucide-react";
import { PROJECT_STATUS_META } from "./ProjectsTab";
import type { CustomerRef } from "./ProjectsTab";
import { backdropCls, btnDeny, btnPrimary, chipCls, errorBoxCls, inputCls, noteBoxCls, slideoverCls } from "./ui";

interface Milestone {
  title: string;
  dueAt?: string;
  status: string;
}

interface TimeEntry {
  id: string;
  minutes: number;
  description: string | null;
  actor: string | null;
  occurredAt: string;
  billed: boolean;
}

interface Summary {
  project: {
    id: string;
    name: string;
    status: string;
    milestones: Milestone[];
    customerId: string | null;
  };
  progress: { total: number; done: number; open: number; pct: number };
  totals: { totalMinutes: number; billedMinutes: number; unbilledMinutes: number; entries: number };
  customer: CustomerRef | null;
}

function fmtDate(v: string | null | undefined): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

export function ProjectDetail({
  projectId,
  onClose,
  onChanged,
}: {
  projectId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newDue, setNewDue] = useState("");
  const [hours, setHours] = useState("");
  const [timeDesc, setTimeDesc] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [nudge, setNudge] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/ops/projects/${projectId}/summary`);
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? "Failed to load project.");
      setSummary(d as Summary);
      const tr = await fetch(`/api/ops/projects/${projectId}/time-entries`);
      const td = await tr.json();
      if (tr.ok) setEntries((td.entries ?? []) as TimeEntry[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load project.");
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const mutate = useCallback(
    async (key: string, fn: () => Promise<Response>) => {
      setBusy(key);
      setError(null);
      setNudge(null);
      try {
        const r = await fn();
        const d = await r.json();
        if (!r.ok) throw new Error(d.error ?? "Request failed.");
        if (d.nudge) setNudge(d.nudge);
        await load();
        onChanged();
      } catch (e) {
        setError(e instanceof Error ? e.message : "Request failed.");
      } finally {
        setBusy(null);
      }
    },
    [load, onChanged],
  );

  const addMilestone = () =>
    mutate("add-ms", () =>
      fetch(`/api/ops/projects/${projectId}/milestones`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle, ...(newDue ? { dueAt: newDue } : {}) }),
      }),
    ).then(() => {
      setNewTitle("");
      setNewDue("");
    });

  const toggleMilestone = (index: number, to: "done" | "open") =>
    mutate(`ms-${index}`, () =>
      fetch(`/api/ops/projects/${projectId}/milestones/${index}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: to }),
      }),
    );

  const logTime = () => {
    const h = Number(hours);
    if (!Number.isFinite(h) || h <= 0) {
      setError("Enter a positive number of hours.");
      return;
    }
    mutate("log-time", () =>
      fetch(`/api/ops/projects/${projectId}/time-entries`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          minutes: Math.round(h * 60),
          description: timeDesc.trim() || undefined,
        }),
      }),
    ).then(() => {
      setHours("");
      setTimeDesc("");
    });
  };

  const markBilled = (entryId: string) =>
    mutate(`billed-${entryId}`, () =>
      fetch(`/api/ops/projects/${projectId}/time-entries/${entryId}/billed`, { method: "POST" }),
    );

  const complete = () =>
    mutate("complete", () => fetch(`/api/ops/projects/${projectId}/complete`, { method: "POST" }));

  const holdOrResume = (to: string) =>
    mutate(`status-${to}`, () =>
      fetch(`/api/ops/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: projectId, status: to }),
      }),
    );

  const meta = summary ? PROJECT_STATUS_META[summary.project.status] : null;
  const terminal = summary && (summary.project.status === "completed" || summary.project.status === "cancelled");

  return (
    <>
      <div className={backdropCls} onClick={onClose} aria-hidden />
      <div className={slideoverCls}>
        <div className="flex h-full flex-col">
          <div className="flex items-start justify-between border-b border-line px-5 py-4">
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-lg font-bold tracking-tight text-ink">
                  {summary ? summary.project.name : "Project"}
                </h3>
                {meta && (
                  <span className={chipCls}>
                    {meta.label}
                  </span>
                )}
              </div>
              {summary?.customer && (
                <p className="mt-0.5 text-[0.8125rem] text-muted">
                  {summary.customer.name}
                  {summary.customer.company ? ` · ${summary.customer.company}` : ""}
                </p>
              )}
            </div>
            <button onClick={onClose} className="rounded-md p-1.5 text-subtle hover:bg-hover-paper hover:text-ink" aria-label="Close">
              <X size={18} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {error && (
              <div className={`${errorBoxCls} mb-3`}>
                {error}
              </div>
            )}
            {nudge && (
              <div className={`${noteBoxCls} mb-3`}>
                {nudge}
              </div>
            )}
            {loading || !summary ? (
              <div className="flex items-center gap-2 text-[0.8125rem] text-muted">
                <Loader2 size={16} className="animate-spin" /> Loading…
              </div>
            ) : (
              <div className="flex flex-col gap-6">
                {/* Progress + time header */}
                <div className="flex flex-wrap gap-4 text-[0.8125rem] text-muted">
                  <span>
                    Milestones{" "}
                    <span className="font-bold text-ink tabular-nums">
                      {summary.progress.done}/{summary.progress.total}
                    </span>{" "}
                    <span className="text-subtle">({summary.progress.pct}%)</span>
                  </span>
                  <span>
                    Time{" "}
                    <span className="font-bold text-ink tabular-nums">
                      {fmtMinutes(summary.totals.totalMinutes)}
                    </span>
                  </span>
                  {summary.totals.unbilledMinutes > 0 && (
                    <span className="text-ink">
                      Unbilled{" "}
                      <span className="font-bold tabular-nums">
                        {fmtMinutes(summary.totals.unbilledMinutes)}
                      </span>
                    </span>
                  )}
                </div>

                {/* Milestones */}
                <section>
                  <h4 className="mb-2 text-[0.8125rem] font-bold text-ink">Milestones</h4>
                  {summary.project.milestones.length === 0 ? (
                    <p className="text-[0.8125rem] text-muted">No milestones yet — add the first one below.</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {summary.project.milestones.map((m, i) => (
                        <li
                          key={i}
                          className="flex items-center gap-2.5 rounded-md border border-line bg-paper px-3 py-2"
                        >
                          <button
                            onClick={() => toggleMilestone(i, m.status === "done" ? "open" : "done")}
                            disabled={busy !== null || !!terminal}
                            className={`flex h-5 w-5 items-center justify-center rounded-full border ${
                              m.status === "done"
                                ? "border-ink bg-ink text-white"
                                : "border-control text-transparent hover:border-ink"
                            }`}
                            aria-label={m.status === "done" ? "Reopen milestone" : "Complete milestone"}
                          >
                            {m.status === "done" ? <Check size={13} /> : <RotateCcw size={11} />}
                          </button>
                          <span
                            className={`flex-1 text-[0.8125rem] ${
                              m.status === "done" ? "text-subtle line-through" : "text-ink"
                            }`}
                          >
                            {m.title}
                          </span>
                          <span className="text-[0.75rem] text-subtle">{fmtDate(m.dueAt)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!terminal && (
                    <div className="mt-2 flex gap-2">
                      <input
                        className={`${inputCls} flex-1`}
                        placeholder="New milestone title…"
                        value={newTitle}
                        onChange={(e) => setNewTitle(e.target.value)}
                      />
                      <input
                        type="date"
                        className={`${inputCls} w-36`}
                        value={newDue}
                        onChange={(e) => setNewDue(e.target.value)}
                        aria-label="Due date"
                      />
                      <button
                        onClick={addMilestone}
                        disabled={!newTitle.trim() || busy !== null}
                        className={btnPrimary}
                      >
                        {busy === "add-ms" ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
                        Add
                      </button>
                    </div>
                  )}
                </section>

                {/* Time ledger */}
                <section>
                  <h4 className="mb-2 text-[0.8125rem] font-bold text-ink">Time</h4>
                  {!terminal && (
                    <div className="mb-2 flex gap-2">
                      <input
                        className={`${inputCls} w-24`}
                        placeholder="Hours"
                        inputMode="decimal"
                        value={hours}
                        onChange={(e) => setHours(e.target.value)}
                        aria-label="Hours"
                      />
                      <input
                        className={`${inputCls} flex-1`}
                        placeholder="What was worked on…"
                        value={timeDesc}
                        onChange={(e) => setTimeDesc(e.target.value)}
                      />
                      <button
                        onClick={logTime}
                        disabled={busy !== null}
                        className="inline-flex items-center gap-1.5 rounded-md border border-line bg-paper px-3 py-[7px] text-[0.8125rem] font-semibold text-ink hover:bg-canvas disabled:opacity-50"
                      >
                        {busy === "log-time" ? <Loader2 size={15} className="animate-spin" /> : <Clock3 size={15} />}
                        Log
                      </button>
                    </div>
                  )}
                  {entries.length === 0 ? (
                    <p className="text-[0.8125rem] text-muted">No time logged yet.</p>
                  ) : (
                    <ul className="flex flex-col gap-1.5">
                      {entries.map((e) => (
                        <li
                          key={e.id}
                          className="flex items-center gap-2.5 rounded-md border border-line bg-paper px-3 py-2"
                        >
                          <span className="w-16 shrink-0 text-[0.8125rem] font-semibold text-ink tabular-nums">
                            {fmtMinutes(e.minutes)}
                          </span>
                          <span className="flex-1 text-[0.8125rem] text-ink">{e.description ?? "—"}</span>
                          <span className="text-[0.75rem] text-subtle">{fmtDate(e.occurredAt)}</span>
                          {e.billed ? (
                            <span className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-ink">
                              Billed
                            </span>
                          ) : (
                            <button
                              onClick={() => markBilled(e.id)}
                              disabled={busy !== null}
                              className="rounded-full bg-canvas px-2 py-0.5 text-[0.6875rem] font-semibold text-ink hover:bg-hover-paper"
                            >
                              Mark billed
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* Lifecycle actions */}
                {!terminal && (
                  <section className="flex flex-wrap gap-2 border-t border-line pt-4">
                    {summary.project.status === "active" && (
                      <>
                        <button
                          onClick={() => holdOrResume("on_hold")}
                          disabled={busy !== null}
                          className="rounded-md border border-line bg-paper px-3 py-[7px] text-[0.8125rem] font-semibold text-ink hover:bg-canvas"
                        >
                          Put on hold
                        </button>
                        <button
                          onClick={complete}
                          disabled={busy !== null}
                          className={btnPrimary}
                        >
                          {busy === "complete" ? <Loader2 size={15} className="animate-spin" /> : <Check size={15} />}
                          Complete project
                        </button>
                        <button
                          onClick={() => holdOrResume("cancelled")}
                          disabled={busy !== null}
                          className={btnDeny}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                    {summary.project.status === "planning" && (
                      <>
                        <button
                          onClick={() => holdOrResume("active")}
                          disabled={busy !== null}
                          className={btnPrimary}
                        >
                          Start project
                        </button>
                        <button
                          onClick={() => holdOrResume("cancelled")}
                          disabled={busy !== null}
                          className={btnDeny}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                    {summary.project.status === "on_hold" && (
                      <>
                        <button
                          onClick={() => holdOrResume("active")}
                          disabled={busy !== null}
                          className={btnPrimary}
                        >
                          Resume
                        </button>
                        <button
                          onClick={() => holdOrResume("cancelled")}
                          disabled={busy !== null}
                          className={btnDeny}
                        >
                          Cancel
                        </button>
                      </>
                    )}
                  </section>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
