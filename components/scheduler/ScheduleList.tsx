// Marketr — schedules list island (Phase B, W2).
// Warm Operator styling; no emoji.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Notice, btnCls, cardCls, dangerBtnCls, type NoticeState } from "@/components/settings/ui";
import { confirmAction } from "@/lib/ui/feedback";

interface SkillRef {
  id: string;
  name: string;
  slug: string;
}

interface ScheduleRow {
  id: string;
  projectId: string | null;
  triggerType: string;
  cronExpr: string | null;
  eventSource: string | null;
  approvalMode: string;
  concurrencyLimit: number;
  status: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  skill: SkillRef;
}

interface PendingRun {
  id: string;
  trigger: string;
  startedAt: string;
  scheduleId: string | null;
  skill: SkillRef;
}

function triggerLabel(s: ScheduleRow): string {
  if (s.triggerType === "cron") return `Cron · ${s.cronExpr ?? "—"}`;
  return `Event · ${s.eventSource ?? "—"}`;
}

function approvalLabel(mode: string): string {
  if (mode === "supervised") return "Supervised — waits for approval";
  if (mode === "scheduled") return "Scheduled — runs, then reports";
  return "Autopilot — runs silently";
}

export default function ScheduleList({
  projectId,
  workspaceId,
  canManage,
  canApprove,
}: {
  projectId: string;
  workspaceId: string;
  canManage: boolean;
  canApprove: boolean;
}) {
  const [schedules, setSchedules] = useState<ScheduleRow[]>([]);
  const [pending, setPending] = useState<PendingRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}&projectId=${encodeURIComponent(projectId)}`;

  const load = useCallback(async () => {
    const r = await fetch(`/api/schedules?${q}`);
    const j = await r.json();
    if (r.ok) setSchedules(j.schedules ?? []);
    else setNotice({ kind: "error", message: j.error ?? "Failed to load schedules" });
    setLoading(false);
  }, [q]);

  const loadPending = useCallback(async () => {
    // Pending approvals surface per schedule; aggregate the first page of
    // runs across schedules client-side (project-scoped, small N).
    const r = await fetch(`/api/schedules?${q}`);
    const j = await r.json();
    const rows: ScheduleRow[] = j.schedules ?? [];
    const all: PendingRun[] = [];
    for (const s of rows) {
      const rr = await fetch(`/api/schedules/${s.id}/runs?workspaceId=${encodeURIComponent(workspaceId)}&take=5`);
      if (!rr.ok) continue;
      const jj = await rr.json();
      for (const run of jj.runs ?? []) {
        if (run.status === "awaiting_approval") {
          all.push({ id: run.id, trigger: run.trigger, startedAt: run.startedAt, scheduleId: run.scheduleId, skill: s.skill });
        }
      }
    }
    setPending(all);
  }, [q, workspaceId]);

  useEffect(() => {
    load();
    if (canApprove) loadPending();
  }, [load, loadPending, canApprove]);

  async function mutate(id: string, method: string, body?: unknown) {
    setBusy(id + method);
    setNotice(null);
    const r = await fetch(`/api/schedules/${id}?workspaceId=${encodeURIComponent(workspaceId)}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) {
      setNotice({ kind: "error", message: j.error ?? "Request failed" });
      return;
    }
    setNotice({ kind: "ok", message: "Schedule updated." });
    load();
  }

  async function triggerNow(id: string) {
    setBusy(id + "trigger");
    setNotice(null);
    const r = await fetch(`/api/schedules/${id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) {
      setNotice({ kind: "error", message: j.error ?? "Trigger failed" });
      return;
    }
    setNotice({
      kind: "ok",
      message: j.awaitingApproval
        ? "Run proposed — it is waiting for approval before anything executes."
        : "Run started.",
    });
    load();
    if (canApprove) loadPending();
  }

  async function decideRun(runId: string, approve: boolean) {
    setBusy(runId);
    const r = await fetch(`/api/scheduler/runs/${runId}/${approve ? "approve" : "reject"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceId }),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) setNotice({ kind: "error", message: j.error ?? "Decision failed" });
    else setNotice({ kind: "ok", message: approve ? "Run approved and executing." : "Run rejected — nothing executed." });
    loadPending();
  }

  if (loading) return <p className="text-sm text-zinc-500">Loading schedules…</p>;

  return (
    <div className="flex flex-col gap-6">
      <Notice notice={notice} />

      {canApprove && pending.length > 0 && (
        <section className={`${cardCls} border-amber-200 bg-amber-50/40`}>
          <h2 className="text-sm font-semibold text-zinc-900">Waiting for approval ({pending.length})</h2>
          <p className="mt-1 text-xs text-zinc-600">
            Supervised runs execute nothing until you approve them.
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {pending.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
                <span>
                  <span className="font-medium">{run.skill.name}</span>
                  <span className="text-zinc-500"> · {run.trigger} · proposed {new Date(run.startedAt).toLocaleString()}</span>
                </span>
                <span className="flex gap-2">
                  <button className={btnCls} disabled={busy === run.id} onClick={() => decideRun(run.id, true)}>
                    Approve
                  </button>
                  <button className={dangerBtnCls} disabled={busy === run.id} onClick={() => decideRun(run.id, false)}>
                    Reject
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {schedules.length === 0 ? (
        <div className={`${cardCls} text-center`}>
          <p className="font-display text-xl">No schedules yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-zinc-600">
            Schedules run a skill on a cron timetable or when a workspace event fires —
            rank drops, new backlinks, connector errors, decay flags, or published content.
          </p>
          {canManage && (
            <Link
              href={`/dashboard/projects/${projectId}/automations/schedules/new`}
              className="mt-4 inline-block rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover"
            >
              Create your first schedule
            </Link>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {schedules.map((s) => (
            <li key={s.id} className={cardCls}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/dashboard/projects/${projectId}/automations/schedules/${s.id}`}
                      className="font-medium text-zinc-900 hover:text-accent"
                    >
                      {s.skill.name}
                    </Link>
                    <span
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        s.status === "active"
                          ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                          : "border-zinc-200 bg-zinc-100 text-zinc-600"
                      }`}
                    >
                      {s.status}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-600">{triggerLabel(s)}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {approvalLabel(s.approvalMode)} · next run{" "}
                    {s.nextRunAt ? new Date(s.nextRunAt).toLocaleString() : "—"}
                    {s.lastRunAt ? ` · last run ${new Date(s.lastRunAt).toLocaleString()}` : ""}
                  </p>
                </div>
                {canManage && (
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={btnCls}
                      disabled={busy !== null}
                      onClick={() => triggerNow(s.id)}
                    >
                      Run now
                    </button>
                    <button
                      className={btnCls}
                      disabled={busy !== null}
                      onClick={() => mutate(s.id, "PATCH", { status: s.status === "active" ? "paused" : "active" })}
                    >
                      {s.status === "active" ? "Pause" : "Resume"}
                    </button>
                    <button
                      className={dangerBtnCls}
                      disabled={busy !== null}
                      onClick={async () => {
                        if (await confirmAction(`Delete this schedule for "${s.skill.name}"? Run history is kept.`)) {
                          mutate(s.id, "DELETE");
                        }
                      }}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
