"use client";

// Marketr — CAD + Hardware slice 4: project hub tasks/issues.
// Revision-linked task tracking: tasks pin to an immutable CadModelVersion
// (v7 stays v7); the pin is a reference — closing a task never mutates the
// version row. Comments and status changes form one activity trail.

import { useCallback, useEffect, useState } from "react";
import { Plus, Loader2, MessageSquare, Trash2 } from "lucide-react";
import { ErrorNote, LoadingNote, StatusPill } from "./ProjectHubTab";

interface ModelSummary {
  id: string;
  name: string;
}

interface VersionSummary {
  id: string;
  versionNumber: number;
  format: string;
}

interface TaskRow {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee: string | null;
  dueDate: string | null;
  modelVersionId: string | null;
  createdAt: string;
  modelVersion?: {
    id: string;
    versionNumber: number;
    format: string;
    model: { id: string; name: string };
  } | null;
}

interface TaskDetail {
  task: TaskRow;
  comments: {
    id: string;
    eventKind: string;
    body: string;
    author: string;
    createdAt: string;
  }[];
  pinnedVersion: {
    id: string;
    versionNumber: number;
    format: string;
    uploadedAt: string;
    model: { id: string; name: string };
  } | null;
}

const STATUSES = ["open", "in_progress", "blocked", "done"] as const;

function statusLabel(s: string): string {
  return s.replace("_", " ");
}

export function ProjectHubTasks({ projectId }: { projectId: string }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showCreate, setShowCreate] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (kindFilter !== "all") params.set("kind", kindFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      const q = params.toString() ? `?${params.toString()}` : "";
      const res = await fetch(`/api/cad/projects/${projectId}/tasks${q}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load tasks.");
      setTasks(body.tasks as TaskRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load tasks.");
    } finally {
      setLoading(false);
    }
  }, [projectId, kindFilter, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={kindFilter}
          onChange={(e) => setKindFilter(e.target.value)}
          aria-label="Filter by kind"
          className="h-10 rounded-md border border-control bg-paper px-3 text-sm text-ink"
        >
          <option value="all">Tasks + issues</option>
          <option value="task">Tasks</option>
          <option value="issue">Issues</option>
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          aria-label="Filter by status"
          className="h-10 rounded-md border border-control bg-paper px-3 text-sm text-ink"
        >
          <option value="all">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{statusLabel(s)}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setShowCreate((s) => !s)}
          className="flex h-10 items-center gap-1.5 rounded-full bg-ink px-4 text-sm font-semibold text-paper"
        >
          <Plus className="h-4 w-4" aria-hidden />
          New task
        </button>
      </div>

      {showCreate && (
        <CreateTaskForm
          projectId={projectId}
          onDone={() => {
            setShowCreate(false);
            load();
          }}
          onCancel={() => setShowCreate(false)}
        />
      )}

      {loading ? (
        <LoadingNote label="Loading tasks" />
      ) : error ? (
        <ErrorNote message={error} />
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted">
          No tasks or issues yet. Tasks pin to a project revision — create one
          to track the work on a specific version.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-canvas text-left text-xs font-semibold text-muted">
                <th className="px-3 py-2.5">Title</th>
                <th className="px-3 py-2.5">Kind</th>
                <th className="px-3 py-2.5">Status</th>
                <th className="px-3 py-2.5">Priority</th>
                <th className="px-3 py-2.5">Revision</th>
                <th className="px-3 py-2.5">Assignee</th>
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <TaskRowView
                  key={t.id}
                  task={t}
                  open={openId === t.id}
                  onToggle={() => setOpenId((o) => (o === t.id ? null : t.id))}
                  onChanged={load}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function TaskRowView({
  task,
  open,
  onToggle,
  onChanged,
}: {
  task: TaskRow;
  open: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  return (
    <>
      <tr className="border-b border-line last:border-0 hover:bg-hover-paper">
        <td className="px-3 py-2.5">
          <button
            type="button"
            onClick={onToggle}
            className="font-medium text-ink underline-offset-2 hover:underline"
          >
            {task.title}
          </button>
          {task.description && (
            <p className="mt-0.5 max-w-md truncate text-xs text-muted">{task.description}</p>
          )}
        </td>
        <td className="px-3 py-2.5"><StatusPill>{task.kind}</StatusPill></td>
        <td className="px-3 py-2.5"><StatusPill>{statusLabel(task.status)}</StatusPill></td>
        <td className="px-3 py-2.5"><StatusPill>{task.priority}</StatusPill></td>
        <td className="px-3 py-2.5 font-mono text-xs text-muted">
          {task.modelVersion
            ? `${task.modelVersion.model.name} v${task.modelVersion.versionNumber}`
            : "—"}
        </td>
        <td className="px-3 py-2.5 text-sm text-muted">{task.assignee ?? "—"}</td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-canvas">
          <td colSpan={6} className="px-3 py-3">
            <TaskDetailView taskId={task.id} onChanged={onChanged} />
          </td>
        </tr>
      )}
    </>
  );
}

function TaskDetailView({ taskId, onChanged }: { taskId: string; onChanged: () => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/tasks/${taskId}`);
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not load the task.");
      setDetail(body as TaskDetail);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the task.");
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    load();
  }, [load]);

  const mutate = async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fn();
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Request failed.");
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const setStatus = (status: string) =>
    mutate(() =>
      fetch(`/api/cad/tasks/${taskId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status }),
      }),
    );

  const addComment = () =>
    mutate(() =>
      fetch(`/api/cad/tasks/${taskId}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: comment.trim() }),
      }),
    ).then(() => setComment(""));

  const deleteTask = async () => {
    if (!window.confirm("Delete this task and its activity trail?")) return;
    await mutate(() => fetch(`/api/cad/tasks/${taskId}`, { method: "DELETE" }));
  };

  if (loading) return <LoadingNote label="Loading the task" />;
  if (error || !detail) return <ErrorNote message={error ?? "Could not load the task."} />;

  const { task, comments, pinnedVersion } = detail;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div>
        <div className="mb-2 flex items-center gap-2 text-xs text-muted">
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          Activity trail
          {pinnedVersion && (
            <span className="font-mono">
              Pinned to {pinnedVersion.model.name} v{pinnedVersion.versionNumber} —
              the revision row is never mutated by task changes.
            </span>
          )}
        </div>
        <ul className="mb-3 space-y-2">
          {comments.map((c) => (
            <li key={c.id} className="rounded-lg border border-line bg-paper p-3">
              <p className="text-sm text-ink">{c.body}</p>
              <p className="mt-1 font-mono text-xs text-muted">
                {c.author} · {new Date(c.createdAt).toLocaleString()}
                {c.eventKind !== "comment" && ` · ${c.eventKind.replace(/_/g, " ")}`}
              </p>
            </li>
          ))}
        </ul>
        {error && (
          <p className="mb-2 text-sm text-failed-text">{error}</p>
        )}
        <div className="flex gap-2">
          <input
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Add a comment"
            className="h-10 min-w-0 flex-1 rounded-md border border-control bg-paper px-3 text-sm text-ink"
          />
          <button
            type="button"
            onClick={addComment}
            disabled={busy || !comment.trim()}
            className="flex h-10 items-center rounded-full bg-ink px-4 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
          >
            {busy && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" aria-hidden />}
            Comment
          </button>
        </div>
      </div>
      <div className="space-y-3">
        <div>
          <p className="mb-1.5 text-xs font-semibold text-ink">Status</p>
          <div className="flex flex-wrap gap-1.5">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                disabled={busy || task.status === s}
                className={`rounded-full px-3 py-1.5 text-xs font-semibold ${
                  task.status === s
                    ? "bg-ink text-paper"
                    : "bg-paper text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
                } disabled:opacity-50`}
              >
                {statusLabel(s)}
              </button>
            ))}
          </div>
          {task.dueDate && (
            <p className="mt-2 text-xs text-muted">
              Due {new Date(task.dueDate).toLocaleDateString()}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={deleteTask}
          disabled={busy}
          className="flex h-10 items-center gap-1.5 rounded-full px-4 text-sm font-semibold text-failed-text shadow-[inset_0_0_0_1.5px_var(--aos-ink)] disabled:opacity-50"
        >
          <Trash2 className="h-4 w-4" aria-hidden />
          Delete task
        </button>
      </div>
    </div>
  );
}

function CreateTaskForm({
  projectId,
  onDone,
  onCancel,
}: {
  projectId: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("task");
  const [priority, setPriority] = useState("medium");
  const [assignee, setAssignee] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [description, setDescription] = useState("");
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [modelId, setModelId] = useState("");
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [versionId, setVersionId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/cad/projects/${projectId}/models`)
      .then((r) => r.json())
      .then((b) => setModels((b?.models ?? []) as ModelSummary[]))
      .catch(() => setModels([]));
  }, [projectId]);

  useEffect(() => {
    if (!modelId) {
      setVersions([]);
      setVersionId("");
      return;
    }
    fetch(`/api/cad/models/${modelId}`)
      .then((r) => r.json())
      .then((b) => setVersions((b?.versions ?? []) as VersionSummary[]))
      .catch(() => setVersions([]));
  }, [modelId]);

  const submit = async () => {
    if (!title.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/cad/projects/${projectId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          kind,
          priority,
          assignee: assignee.trim() || null,
          dueDate: dueDate || null,
          description: description.trim() || null,
          modelVersionId: versionId || null,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error ?? "Could not create the task.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the task.");
    } finally {
      setBusy(false);
    }
  };

  const field =
    "h-10 w-full rounded-md border border-control bg-paper px-3 text-sm text-ink";

  return (
    <div className="rounded-lg border border-line bg-paper p-4 shadow-hairline">
      <div className="grid gap-3 md:grid-cols-2">
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-title">
            Title
          </label>
          <input
            id="hw-task-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Check wall thickness on airframe v7"
            className={field}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-kind">
            Kind
          </label>
          <select id="hw-task-kind" value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
            <option value="task">Task</option>
            <option value="issue">Issue</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-priority">
            Priority
          </label>
          <select id="hw-task-priority" value={priority} onChange={(e) => setPriority(e.target.value)} className={field}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-assignee">
            Assignee <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="hw-task-assignee"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
            placeholder="Name or email"
            className={field}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-due">
            Due date <span className="font-normal text-muted">(optional)</span>
          </label>
          <input
            id="hw-task-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className={field}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-model">
            Pin to model <span className="font-normal text-muted">(optional)</span>
          </label>
          <select
            id="hw-task-model"
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            className={field}
          >
            <option value="">No pin — project-level</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-version">
            Pin to revision
          </label>
          <select
            id="hw-task-version"
            value={versionId}
            onChange={(e) => setVersionId(e.target.value)}
            disabled={!modelId}
            className={field}
          >
            <option value="">Current revision at creation</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                v{v.versionNumber} · {v.format.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs font-semibold text-ink" htmlFor="hw-task-desc">
            Description <span className="font-normal text-muted">(optional)</span>
          </label>
          <textarea
            id="hw-task-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-control bg-paper px-3 py-2 text-sm text-ink"
          />
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-failed-text">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="flex h-10 items-center rounded-full bg-paper px-4 text-sm font-semibold text-ink shadow-[inset_0_0_0_1.5px_var(--aos-ink)]"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={submit}
          disabled={busy || !title.trim()}
          className="flex h-10 items-center gap-2 rounded-full bg-ink px-5 text-sm font-semibold text-paper disabled:bg-disabled disabled:text-disabled-fg"
        >
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          Create task
        </button>
      </div>
    </div>
  );
}
