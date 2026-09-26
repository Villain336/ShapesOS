// Marketr — workspace audit log viewer (milestone 21, part D1).
// Client component: filterable audit table (actor/action/project/date range)
// with CSV export. Spec §5 flow 7: every skill install/enable, connector
// connect/disconnect, file attach, and settings change appears here.

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Notice,
  btnCls,
  cardCls,
  inputCls,
  labelCls,
  primaryBtnVioletCls,
  type NoticeState,
} from "./ui";

interface AuditEvent {
  id: string;
  action: string;
  actor: string | null;
  summary: string | null;
  projectId: string | null;
  createdAt: string;
}

// Event types the M21 flows emit (spec §6). Kept as the select options so the
// filter stays honest about what the audit trail covers.
const ACTIONS = [
  "skill.installed",
  "skill.enabled",
  "skill.disabled",
  "connector.connected",
  "connector.disconnected",
  "connector.reauth",
  "file.attached",
  "file.removed",
  "settings.workspace_updated",
  "settings.project_updated",
] as const;

export default function AuditLogViewer({ workspaceId }: { workspaceId: string }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [projectId, setProjectId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  function params(): URLSearchParams {
    const p = new URLSearchParams({ workspaceId });
    if (action) p.set("action", action);
    if (actor.trim()) p.set("actor", actor.trim());
    if (projectId.trim()) p.set("projectId", projectId.trim());
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    return p;
  }

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const r = await fetch(`/api/settings/audit?${params().toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setNotice({
          kind: "error",
          message: typeof j.error === "string" ? j.error : "Could not load the audit log.",
        });
        return;
      }
      setEvents(j.events ?? []);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, action, actor, projectId, from, to]);

  useEffect(() => {
    load();
  }, [load]);

  function exportCsvUrl(): string {
    const p = params();
    p.set("format", "csv");
    return `/api/settings/audit?${p.toString()}`;
  }

  function clearFilters() {
    setAction("");
    setActor("");
    setProjectId("");
    setFrom("");
    setTo("");
  }

  return (
    <div className="flex flex-col gap-4">
      <div className={cardCls}>
        <h2 className="font-medium">Filters</h2>
        <div className="mt-3 grid gap-2 md:grid-cols-3">
          <label className={labelCls}>
            Action
            <select
              value={action}
              onChange={(e) => setAction(e.target.value)}
              className={`${inputCls} mt-1 w-full`}
            >
              <option value="">All actions</option>
              {ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
          <label className={labelCls}>
            Actor
            <input
              value={actor}
              onChange={(e) => setActor(e.target.value)}
              placeholder="user id or email"
              className={`${inputCls} mt-1 w-full`}
            />
          </label>
          <label className={labelCls}>
            Project id
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="project id"
              className={`${inputCls} mt-1 w-full font-mono text-xs`}
            />
          </label>
          <label className={labelCls}>
            From
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className={`${inputCls} mt-1 w-full`}
            />
          </label>
          <label className={labelCls}>
            To
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className={`${inputCls} mt-1 w-full`}
            />
          </label>
          <div className="flex items-end gap-2">
            <button onClick={load} disabled={loading} className={primaryBtnVioletCls}>
              {loading ? "Loading…" : "Apply filters"}
            </button>
            <button onClick={clearFilters} disabled={loading} className={btnCls}>
              Clear
            </button>
            <a href={exportCsvUrl()} download className={btnCls}>
              Export CSV
            </a>
          </div>
        </div>
      </div>

      <Notice notice={notice} />

      <div className="overflow-hidden rounded-xl border border-zinc-200">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-200 bg-white/60 text-left text-xs uppercase tracking-widest text-zinc-500">
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Actor</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Project</th>
              <th className="px-4 py-3">Summary</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e) => (
              <tr key={e.id} className="border-b border-zinc-200/60 last:border-0">
                <td className="whitespace-nowrap px-4 py-3 text-xs text-zinc-500">
                  {new Date(e.createdAt).toLocaleString()}
                </td>
                <td className="px-4 py-3 text-xs">{e.actor ?? "—"}</td>
                <td className="px-4 py-3 font-mono text-xs">{e.action}</td>
                <td className="px-4 py-3 font-mono text-xs text-zinc-500">
                  {e.projectId ? e.projectId.slice(0, 12) : "—"}
                </td>
                <td className="px-4 py-3 text-xs text-zinc-600">{e.summary ?? "—"}</td>
              </tr>
            ))}
            {events.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                  No audit events match these filters.
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                  Loading…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
