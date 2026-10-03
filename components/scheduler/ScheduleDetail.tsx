// Marketr — schedule detail island (Phase B, W2).
// Edit approval mode / concurrency / trigger config, pause/resume/delete,
// manual trigger, run history, approve/reject for supervised runs.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Notice, btnCls, cardCls, dangerBtnCls, inputCls, labelCls, primaryBtnCls, type NoticeState } from "@/components/settings/ui";
import { confirmAction } from "@/lib/ui/feedback";

interface RunRow {
  id: string;
  trigger: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  creditsUsed: number;
  wasMissed: boolean;
  _count: { subagents: number };
}

interface ScheduleInfo {
  id: string;
  triggerType: string;
  cronExpr: string | null;
  eventSource: string | null;
  eventConfig: Record<string, unknown> | null;
  approvalMode: string;
  concurrencyLimit: number;
  status: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  skill: { id: string; name: string; slug: string };
}

export default function ScheduleDetail({
  projectId,
  workspaceId,
  schedule,
  canManage,
  canApprove,
}: {
  projectId: string;
  workspaceId: string;
  schedule: ScheduleInfo;
  canManage: boolean;
  canApprove: boolean;
}) {
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [approvalMode, setApprovalMode] = useState(schedule.approvalMode);
  const [concurrencyLimit, setConcurrencyLimit] = useState(schedule.concurrencyLimit);
  const [cronExpr, setCronExpr] = useState(schedule.cronExpr ?? "");
  const [editing, setEditing] = useState(false);

  const q = `workspaceId=${encodeURIComponent(workspaceId)}`;

  const loadRuns = useCallback(async () => {
    const r = await fetch(`/api/schedules/${schedule.id}/runs?${q}`);
    const j = await r.json();
    if (r.ok) setRuns(j.runs ?? []);
  }, [schedule.id, q]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  async function patch(body: Record<string, unknown>) {
    setBusy("patch");
    setNotice(null);
    const r = await fetch(`/api/schedules/${schedule.id}?${q}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    setBusy(null);
    if (!r.ok) {
      setNotice({ kind: "error", message: j.error ?? "Update failed" });
      return false;
    }
    setNotice({ kind: "ok", message: "Schedule updated." });
    setEditing(false);
    return true;
  }

  async function triggerNow() {
    setBusy("trigger");
    setNotice(null);
    const r = await fetch(`/api/schedules/${schedule.id}/runs`, {
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
      message: j.awaitingApproval ? "Run proposed — waiting for approval." : "Run started.",
    });
    loadRuns();
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
    else {
      setNotice({ kind: "ok", message: approve ? "Run approved and executing." : "Run rejected." });
      loadRuns();
    }
  }

  async function remove() {
    if (!await confirmAction(`Delete this schedule for "${schedule.skill.name}"? Run history is kept.`)) return;
    setBusy("delete");
    const r = await fetch(`/api/schedules/${schedule.id}?${q}`, { method: "DELETE" });
    setBusy(null);
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      setNotice({ kind: "error", message: j.error ?? "Delete failed" });
      return;
    }
    window.location.href = `/dashboard/projects/${projectId}/automations/schedules`;
  }

  return (
    <div className="flex flex-col gap-6">
      <Notice notice={notice} />

      <section className={cardCls}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-zinc-900">{schedule.skill.name}</h2>
            <p className="mt-1 text-sm text-zinc-600">
              {schedule.triggerType === "cron" ? `Cron · ${schedule.cronExpr}` : `Event · ${schedule.eventSource}`}
              {" · "}
              <span className={schedule.status === "active" ? "text-emerald-700" : "text-zinc-500"}>{schedule.status}</span>
            </p>
            <p className="mt-0.5 text-xs text-zinc-500">
              Next run {schedule.nextRunAt ? new Date(schedule.nextRunAt).toLocaleString() : "—"}
              {schedule.lastRunAt ? ` · Last run ${new Date(schedule.lastRunAt).toLocaleString()}` : ""}
            </p>
          </div>
          {canManage && (
            <div className="flex flex-wrap gap-2">
              <button className={btnCls} disabled={busy !== null} onClick={triggerNow}>Run now</button>
              <button className={btnCls} disabled={busy !== null} onClick={() => patch({ status: schedule.status === "active" ? "paused" : "active" }).then((ok) => ok && window.location.reload())}>
                {schedule.status === "active" ? "Pause" : "Resume"}
              </button>
              <button className={dangerBtnCls} disabled={busy !== null} onClick={remove}>Delete</button>
            </div>
          )}
        </div>

        {canManage && (
          <div className="mt-4 border-t border-zinc-200 pt-4">
            {!editing ? (
              <button className={btnCls} onClick={() => setEditing(true)}>Edit settings</button>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-4">
                  <label className={labelCls}>
                    Approval mode
                    <select className={`${inputCls} mt-1`} value={approvalMode} onChange={(e) => setApprovalMode(e.target.value)}>
                      <option value="supervised">Supervised — waits for approval</option>
                      <option value="scheduled">Scheduled — runs, then reports</option>
                      <option value="autopilot">Autopilot — runs silently</option>
                    </select>
                  </label>
                  <label className={labelCls}>
                    Max parallel subagents
                    <input type="number" min={1} max={16} className={`${inputCls} mt-1 w-32`} value={concurrencyLimit}
                      onChange={(e) => setConcurrencyLimit(Math.min(16, Math.max(1, Number(e.target.value) || 4)))} />
                  </label>
                </div>
                {schedule.triggerType === "cron" && (
                  <label className={labelCls}>
                    Cron expression (5 fields)
                    <input className={`${inputCls} mt-1 w-64 font-mono`} value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} />
                  </label>
                )}
                <div className="flex gap-2">
                  <button className={primaryBtnCls} disabled={busy !== null}
                    onClick={() => patch({ approvalMode, concurrencyLimit, ...(schedule.triggerType === "cron" ? { cronExpr } : {}) }).then((ok) => ok && window.location.reload())}>
                    Save
                  </button>
                  <button className={btnCls} onClick={() => setEditing(false)}>Cancel</button>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className={cardCls}>
        <h2 className="text-sm font-semibold text-zinc-900">Run history</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No runs yet.</p>
        ) : (
          <ul className="mt-3 flex flex-col gap-2">
            {runs.map((run) => (
              <li key={run.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm">
                <span>
                  <Link
                    href={`/dashboard/projects/${projectId}/automations/schedules/runs/${run.id}`}
                    className="font-medium text-zinc-900 hover:text-accent"
                  >
                    {new Date(run.startedAt).toLocaleString()}
                  </Link>
                  <span className="text-zinc-500">
                    {" · "}{run.trigger}{" · "}{run.status}
                    {run.wasMissed ? " · missed window" : ""}
                    {" · "}{run._count.subagents} subagents{" · "}{run.creditsUsed} credits
                  </span>
                </span>
                {run.status === "awaiting_approval" && canApprove && (
                  <span className="flex gap-2">
                    <button className={btnCls} disabled={busy === run.id} onClick={() => decideRun(run.id, true)}>Approve</button>
                    <button className={dangerBtnCls} disabled={busy === run.id} onClick={() => decideRun(run.id, false)}>Reject</button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
